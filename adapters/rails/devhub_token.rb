# frozen_string_literal: true

require "base64"
require "json"
require "openssl"

# Local Dev Hub - Magic Login token verifier (plain Ruby, OpenSSL 3 / Ruby 3.1+).
#
# Tokens are compact JWTs signed with Ed25519 ("EdDSA"). The public key is the
# single-line base64 SPKI value from the hub's Settings page (DEVHUB_PUBLIC_KEY).
module DevhubToken
  class Error < StandardError; end

  module_function

  def verify(token, public_key, audience, now: Time.now.to_i, skew: 5)
    parts = token.to_s.split(".")
    raise Error, "Malformed token" unless parts.length == 3

    header, payload, signature = parts
    alg = begin
      JSON.parse(b64url(header))["alg"]
    rescue JSON::ParserError
      raise Error, "Malformed token header"
    end
    raise Error, "Unexpected token algorithm" unless alg == "EdDSA"

    key = begin
      OpenSSL::PKey.read(Base64.strict_decode64(public_key.to_s.strip))
    rescue ArgumentError, OpenSSL::PKey::PKeyError
      raise Error, "DEVHUB_PUBLIC_KEY must be the base64 SPKI value from Local Dev Hub"
    end
    raise Error, "DEVHUB_PUBLIC_KEY is not an Ed25519 key" unless key.oid == "ED25519"

    valid = begin
      key.verify(nil, b64url(signature), "#{header}.#{payload}")
    rescue OpenSSL::PKey::PKeyError
      false
    end
    raise Error, "Invalid signature" unless valid

    claims = JSON.parse(b64url(payload))
    raise Error, "Wrong issuer" unless claims["iss"] == "devhub"
    raise Error, "Token is for another project" unless claims["aud"] == audience
    raise Error, "Token expired" unless claims["exp"].is_a?(Integer) && claims["exp"] + skew >= now
    raise Error, "Token issued in the future" unless claims["iat"].is_a?(Integer) && claims["iat"] - skew <= now
    raise Error, "Token is missing sub or jti" if claims["sub"].to_s.empty? || claims["jti"].to_s.empty?

    claims
  end

  # Only same-site relative paths, so a token can't be used as an open redirect.
  def safe_redirect(redirect, fallback = "/")
    return fallback if redirect.nil? || !redirect.start_with?("/") || redirect.start_with?("//") || redirect.include?("\\")

    redirect
  end

  def b64url(value)
    Base64.urlsafe_decode64(value + ("=" * (-value.length % 4)))
  rescue ArgumentError
    raise Error, "Malformed token encoding"
  end
end
