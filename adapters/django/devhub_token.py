"""Local Dev Hub - Magic Login token verifier (framework independent).

Needs the `cryptography` package. Tokens are compact JWTs signed with Ed25519
("EdDSA"). The public key is the single-line base64 SPKI value from the hub's
Settings page (DEVHUB_PUBLIC_KEY).
"""

import base64
import json
import time

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_der_public_key


class DevhubTokenError(Exception):
    pass


def _b64url(value: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise DevhubTokenError("Malformed token encoding") from exc


def verify_devhub_token(token: str, public_key: str, audience: str, now: int | None = None, skew: int = 5) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise DevhubTokenError("Malformed token")
    header, payload, signature = parts

    try:
        alg = json.loads(_b64url(header)).get("alg")
    except ValueError as exc:
        raise DevhubTokenError("Malformed token header") from exc
    if alg != "EdDSA":
        raise DevhubTokenError("Unexpected token algorithm")

    try:
        key = load_der_public_key(base64.b64decode(public_key.strip()))
    except ValueError as exc:
        raise DevhubTokenError("DEVHUB_PUBLIC_KEY must be the base64 SPKI value from Local Dev Hub") from exc
    if not isinstance(key, Ed25519PublicKey):
        raise DevhubTokenError("DEVHUB_PUBLIC_KEY is not an Ed25519 key")
    try:
        key.verify(_b64url(signature), f"{header}.{payload}".encode())
    except InvalidSignature as exc:
        raise DevhubTokenError("Invalid signature") from exc

    claims = json.loads(_b64url(payload))
    now = int(time.time()) if now is None else now
    if claims.get("iss") != "devhub":
        raise DevhubTokenError("Wrong issuer")
    if claims.get("aud") != audience:
        raise DevhubTokenError("Token is for another project")
    if not isinstance(claims.get("exp"), int) or claims["exp"] + skew < now:
        raise DevhubTokenError("Token expired")
    if not isinstance(claims.get("iat"), int) or claims["iat"] - skew > now:
        raise DevhubTokenError("Token issued in the future")
    if not claims.get("sub") or not claims.get("jti"):
        raise DevhubTokenError("Token is missing sub or jti")
    return claims


def safe_redirect(redirect: str | None, fallback: str = "/") -> str:
    """Only same-site relative paths, so a token can't be used as an open redirect."""
    if not redirect or not redirect.startswith("/") or redirect.startswith("//") or "\\" in redirect:
        return fallback
    return redirect
