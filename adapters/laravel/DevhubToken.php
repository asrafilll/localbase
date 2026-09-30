<?php

namespace App\Support\Devhub;

use RuntimeException;

/**
 * Local Dev Hub - Magic Login token verifier (framework independent, needs ext-sodium).
 *
 * Tokens are compact JWTs signed with Ed25519 (alg "EdDSA"). The public key is
 * the single-line base64 SPKI value from the hub's Settings page (DEVHUB_PUBLIC_KEY).
 */
final class DevhubToken
{
    /** @return array{iss:string,aud:string,sub:string,persona:string,role?:string,redirect?:string,iat:int,exp:int,jti:string} */
    public static function verify(string $token, string $publicKey, string $audience, ?int $now = null, int $skew = 5): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new RuntimeException('Malformed token');
        }
        [$header, $payload, $signature] = $parts;

        $headerData = json_decode(self::b64url($header), true);
        if (($headerData['alg'] ?? null) !== 'EdDSA') {
            throw new RuntimeException('Unexpected token algorithm');
        }

        // An Ed25519 SPKI DER key is a fixed 12-byte prefix followed by the 32-byte raw key.
        $der = base64_decode(trim($publicKey), true);
        if ($der === false || strlen($der) !== 44) {
            throw new RuntimeException('DEVHUB_PUBLIC_KEY must be the base64 SPKI value from Local Dev Hub');
        }
        $rawKey = substr($der, -32);

        $sig = self::b64url($signature);
        if (strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES
            || ! sodium_crypto_sign_verify_detached($sig, "{$header}.{$payload}", $rawKey)) {
            throw new RuntimeException('Invalid signature');
        }

        $claims = json_decode(self::b64url($payload), true);
        $now ??= time();
        if (! is_array($claims) || ($claims['iss'] ?? null) !== 'devhub') {
            throw new RuntimeException('Wrong issuer');
        }
        if (($claims['aud'] ?? null) !== $audience) {
            throw new RuntimeException('Token is for another project');
        }
        if (! is_int($claims['exp'] ?? null) || $claims['exp'] + $skew < $now) {
            throw new RuntimeException('Token expired');
        }
        if (! is_int($claims['iat'] ?? null) || $claims['iat'] - $skew > $now) {
            throw new RuntimeException('Token issued in the future');
        }
        if (empty($claims['sub']) || empty($claims['jti'])) {
            throw new RuntimeException('Token is missing sub or jti');
        }

        return $claims;
    }

    /** Only same-site relative paths, so a token can't be used as an open redirect. */
    public static function safeRedirect(?string $redirect, string $fallback = '/'): string
    {
        if (! $redirect || ! str_starts_with($redirect, '/') || str_starts_with($redirect, '//') || str_contains($redirect, '\\')) {
            return $fallback;
        }

        return $redirect;
    }

    private static function b64url(string $value): string
    {
        $decoded = base64_decode(strtr($value, '-_', '+/'), true);
        if ($decoded === false) {
            throw new RuntimeException('Malformed token encoding');
        }

        return $decoded;
    }
}
