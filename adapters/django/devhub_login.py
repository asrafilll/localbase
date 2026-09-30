"""Local Dev Hub - Magic Login view for Django.

Copy devhub_token.py and this file into an app (e.g. `accounts/`), then:

settings.py (development settings only):
    DEVHUB_PUBLIC_KEY = os.environ.get("DEVHUB_PUBLIC_KEY", "")
    DEVHUB_PROJECT = "fitbase"   # `id` in .dev/project.yaml

urls.py:
    from django.conf import settings
    if settings.DEBUG and getattr(settings, "DEVHUB_PUBLIC_KEY", ""):
        from accounts.devhub_login import devhub_login
        urlpatterns += [path("__devhub/login", devhub_login)]

.dev/project.yaml:
    magicLogin:
      endpoint: http://localhost:8000/__devhub/login
"""

from django.conf import settings
from django.contrib.auth import get_user_model, login
from django.core.cache import cache
from django.http import Http404, HttpResponse
from django.shortcuts import redirect

from .devhub_token import DevhubTokenError, safe_redirect, verify_devhub_token


def devhub_login(request):
    # Defense in depth: even if the URL is registered by mistake, refuse outside DEBUG.
    public_key = getattr(settings, "DEVHUB_PUBLIC_KEY", "")
    if not settings.DEBUG or not public_key:
        raise Http404()

    try:
        claims = verify_devhub_token(
            request.GET.get("token", ""),
            public_key,
            getattr(settings, "DEVHUB_PROJECT", ""),
        )
    except DevhubTokenError as exc:
        return HttpResponse(f"Magic Login failed: {exc}", status=401)

    # Single use: cache.add only succeeds for the first request with this jti.
    if not cache.add(f"devhub:jti:{claims['jti']}", True, timeout=120):
        return HttpResponse("Magic Login failed: token already used", status=401)

    User = get_user_model()
    # `sub` is personas.<key>.user; match it against email or the username field.
    field = "email" if hasattr(User, "email") else User.USERNAME_FIELD
    try:
        user = User.objects.get(**{field: claims["sub"]})
    except User.DoesNotExist:
        return HttpResponse(f"No user {claims['sub']}", status=404)

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    return redirect(safe_redirect(claims.get("redirect")))
