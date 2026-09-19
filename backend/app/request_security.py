"""Browser request checks that remain valid behind the platform reverse proxy."""
from urllib.parse import urlsplit

from fastapi import Request


def same_page_request(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True

    # Browsers calculate this before the platform proxy rewrites Host.
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site:
        return fetch_site == "same-origin"

    origin_host = urlsplit(origin).netloc.lower()
    hosts = {request.headers.get("host", "").lower()}
    forwarded = request.headers.get("x-forwarded-host", "")
    hosts.update(value.strip().lower() for value in forwarded.split(",") if value.strip())
    return origin_host in hosts
