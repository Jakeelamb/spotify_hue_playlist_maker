import base64
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timedelta
from typing import Dict, List, Optional, Tuple

import requests
from flask import Flask, jsonify, redirect, request, session, send_from_directory
from flask_cors import CORS
from flask_session import Session
from urllib.parse import urlparse
from dotenv import load_dotenv

from color_utils import (
    calculate_euclidean_distance,
    extract_dominant_color,
    generate_gradient_image,
    hex_to_rgb,
)
from spotify_client import SpotifyClient


def create_app() -> Flask:
    app = Flask(__name__)

    # Config
    load_dotenv()
    app.secret_key = os.environ.get("SECRET_KEY", os.urandom(32))
    app.config["SESSION_TYPE"] = "filesystem"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=8)

    Session(app)

    frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:8000")
    parsed = urlparse(frontend_url)
    frontend_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else frontend_url
    # Session cookie for cross-site when hosted on GitHub Pages (requires Secure + SameSite=None)
    is_cross_site = frontend_origin.startswith("https://") and "github.io" in frontend_origin
    app.config["SESSION_COOKIE_SAMESITE"] = "None" if is_cross_site else "Lax"
    app.config["SESSION_COOKIE_SECURE"] = bool(is_cross_site)
    CORS(
        app,
        resources={r"/*": {"origins": [frontend_origin], "supports_credentials": True}},
    )

    spotify = SpotifyClient(
        client_id=os.environ.get("CLIENT_ID", ""),
        client_secret=os.environ.get("CLIENT_SECRET", ""),
        redirect_uri=os.environ.get("REDIRECT_URI", "http://localhost:5000/auth/callback"),
        scopes=os.environ.get(
            "SPOTIFY_SCOPES",
            "user-library-read playlist-modify-public playlist-modify-private ugc-image-upload",
        ),
    )

    # Optionally serve frontend for local same-origin testing
    serve_frontend = os.environ.get("SERVE_FRONTEND", "0") == "1"
    if serve_frontend:
        base_dir = os.path.abspath(os.path.dirname(__file__))
        frontend_dir = os.path.abspath(os.path.join(base_dir, "..", "frontend"))

        @app.get("/")
        def serve_index():
            return send_from_directory(frontend_dir, "index.html")

        @app.get("/index.html")
        def serve_index_html():
            return send_from_directory(frontend_dir, "index.html")

        @app.get("/styles.css")
        def serve_css():
            return send_from_directory(frontend_dir, "styles.css")

        @app.get("/app.js")
        def serve_js():
            return send_from_directory(frontend_dir, "app.js")

    image_download_timeout_seconds = float(os.environ.get("IMAGE_TIMEOUT", "5.0"))

    executor = ThreadPoolExecutor(max_workers=int(os.environ.get("WORKERS", "8")))
    executor_lock = threading.Lock()

    def require_token() -> Optional[Tuple[int, Dict[str, str]]]:
        access_token = session.get("access_token")
        refresh_token = session.get("refresh_token")
        if not access_token or not refresh_token:
            return 401, {"error": "unauthorized"}
        return None

    @app.route("/health")
    def health() -> Tuple[str, int]:
        return "ok", 200

    @app.route("/auth/login")
    def auth_login():
        authorize_url = spotify.build_authorize_url(state="state123")
        return redirect(authorize_url)

    @app.route("/auth/callback")
    def auth_callback():
        error = request.args.get("error")
        if error:
            return redirect(f"{frontend_url}/#error={error}")

        code = request.args.get("code")
        if not code:
            return redirect(f"{frontend_url}/#error=missing_code")

        token_data = spotify.exchange_code_for_token(code)
        if "access_token" not in token_data:
            return redirect(f"{frontend_url}/#error=token_exchange_failed")

        session["access_token"] = token_data["access_token"]
        session["refresh_token"] = token_data.get("refresh_token")
        session.permanent = True
        return redirect(f"{frontend_url}/#authed=1")

    @app.route("/me")
    def me():
        guard = require_token()
        if guard:
            return jsonify(guard[1]), guard[0]
        me_data = spotify.get_me(session["access_token"]) or {}
        return jsonify(me_data)

    @app.route("/logout", methods=["POST"]) 
    def logout():
        session.clear()
        return ("", 204)

    def parse_playlist_id_from_url(url: str) -> Optional[str]:
        m = re.search(r"playlist/([a-zA-Z0-9]+)", url)
        return m.group(1) if m else None

    def compute_track_color_distance(
        image_url: str, target_rgb: Tuple[int, int, int]
    ) -> Optional[Tuple[Tuple[int, int, int], float]]:
        try:
            resp = requests.get(image_url, timeout=image_download_timeout_seconds)
            if resp.status_code != 200:
                return None
            dominant = extract_dominant_color(resp.content)
            distance = calculate_euclidean_distance(dominant, target_rgb)
            return dominant, distance
        except requests.RequestException:
            return None

    @app.route("/fetch-tracks", methods=["POST"])
    def fetch_tracks():
        guard = require_token()
        if guard:
            return jsonify(guard[1]), guard[0]

        payload = request.get_json(force=True) or {}
        source = payload.get("source", "liked")
        limit = int(payload.get("limit", 250))
        playlist_url = payload.get("playlist_url")

        if source == "liked":
            tracks = spotify.get_liked_tracks(session["access_token"], limit=limit)
        elif source == "playlist":
            pid = parse_playlist_id_from_url(playlist_url or "")
            if not pid:
                return jsonify({"error": "invalid_playlist_url"}), 400
            tracks = spotify.get_playlist_tracks(session["access_token"], pid, limit=limit)
        else:
            return jsonify({"error": "invalid_source"}), 400

        # Standardize fields
        simplified = []
        for t in tracks:
            album_images = (((t.get("album") or {}).get("images")) or [])
            image_url = album_images[0]["url"] if album_images else None
            simplified.append(
                {
                    "id": t.get("id"),
                    "uri": t.get("uri"),
                    "name": t.get("name"),
                    "artists": ", ".join([a.get("name", "") for a in t.get("artists", [])]),
                    "image_url": image_url,
                }
            )
        return jsonify({"tracks": simplified})

    @app.route("/build", methods=["POST"])
    def build_playlist():
        guard = require_token()
        if guard:
            return jsonify(guard[1]), guard[0]

        data = request.get_json(force=True) or {}
        try:
            target_hex = data["hex"]
        except KeyError:
            return jsonify({"error": "missing_hex"}), 400

        threshold = float(data.get("threshold", 90))
        if threshold >= 100:
            threshold = 99.9

        tracks = data.get("tracks") or []
        if not isinstance(tracks, list) or not tracks:
            return jsonify({"error": "missing_tracks"}), 400

        target_rgb = hex_to_rgb(target_hex)

        futures = {}
        with executor_lock:
            for t in tracks:
                image_url = t.get("image_url")
                if not image_url:
                    continue
                futures[executor.submit(compute_track_color_distance, image_url, target_rgb)] = t

        results = []
        for fut in as_completed(futures):
            t = futures[fut]
            result = fut.result()
            if not result:
                continue
            dominant_rgb, distance = result
            if distance < threshold:
                results.append({"track": t, "dominant": dominant_rgb, "distance": distance})

        results.sort(key=lambda r: r["distance"])  # ascending similarity

        # Optionally trim to top N highest-ranked
        top_n = data.get("top_n")
        if isinstance(top_n, int) and top_n > 0:
            trimmed = results[: top_n]
        else:
            trimmed = results
        uris_sorted = [r["track"]["uri"] for r in trimmed]

        me_data = spotify.get_me(session["access_token"]) or {}
        user_id = me_data.get("id")
        if not user_id:
            return jsonify({"error": "profile_unavailable"}), 400

        playlist_name = data.get("playlist_name") or f"Color Playlist - {target_hex.upper()}"
        playlist = spotify.create_playlist(session["access_token"], user_id, playlist_name)
        playlist_id = playlist.get("id")
        playlist_url = playlist.get("external_urls", {}).get("spotify")

        if uris_sorted:
            spotify.add_tracks(session["access_token"], playlist_id, uris_sorted)

        # Generate cover gradient between target and median dominant color
        if trimmed:
            mid_idx = len(trimmed) // 2
            other_rgb = tuple(int(v) for v in trimmed[mid_idx]["dominant"])  # type: ignore
        else:
            other_rgb = target_rgb

        cover_image = generate_gradient_image(target_rgb, other_rgb, size=(600, 600))
        jpeg_bytes = cover_image
        b64_image = base64.b64encode(jpeg_bytes).decode("utf-8")
        spotify.upload_playlist_cover(session["access_token"], playlist_id, b64_image)

        return jsonify(
            {
                "playlist_id": playlist_id,
                "playlist_url": playlist_url,
                "added": len(uris_sorted),
                "considered": len(tracks),
                "hex": target_hex,
            }
        )

    @app.route("/analyze", methods=["POST"])
    def analyze_tracks():
        guard = require_token()
        if guard:
            return jsonify(guard[1]), guard[0]

        data = request.get_json(force=True) or {}
        try:
            target_hex = data["hex"]
        except KeyError:
            return jsonify({"error": "missing_hex"}), 400

        threshold = float(data.get("threshold", 90))
        if threshold >= 100:
            threshold = 99.9

        tracks = data.get("tracks") or []
        if not isinstance(tracks, list) or not tracks:
            return jsonify({"error": "missing_tracks"}), 400

        target_rgb = hex_to_rgb(target_hex)

        futures = {}
        with executor_lock:
            for t in tracks:
                image_url = t.get("image_url")
                if not image_url:
                    continue
                futures[executor.submit(compute_track_color_distance, image_url, target_rgb)] = t

        results = []
        for fut in as_completed(futures):
            t = futures[fut]
            result = fut.result()
            if not result:
                continue
            dominant_rgb, distance = result
            results.append({"track": t, "dominant": dominant_rgb, "distance": distance})

        results.sort(key=lambda r: r["distance"])  # ascending similarity

        return jsonify({
            "results": results,
            "hex": target_hex,
            "threshold": threshold,
            "total": len(results),
        })

    return app


app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")))


