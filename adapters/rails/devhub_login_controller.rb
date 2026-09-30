# frozen_string_literal: true

# Local Dev Hub - Magic Login endpoint for Rails.
#
# Copy devhub_token.rb to lib/devhub_token.rb and this file to
# app/controllers/devhub_login_controller.rb, then:
#
# config/routes.rb:
#   if Rails.env.development? && ENV["DEVHUB_PUBLIC_KEY"].present?
#     get "/__devhub/login", to: "devhub_login#create"
#   end
#
# .dev/project.yaml:
#   magicLogin:
#     endpoint: http://localhost:3000/__devhub/login
require Rails.root.join("lib/devhub_token")

class DevhubLoginController < ApplicationController
  PROJECT_ID = "fitbase" # `id` in .dev/project.yaml

  skip_forgery_protection

  def create
    # Defense in depth: even if the route leaks into another environment, refuse.
    return head :not_found unless Rails.env.development? && ENV["DEVHUB_PUBLIC_KEY"].present?

    claims = DevhubToken.verify(params[:token], ENV.fetch("DEVHUB_PUBLIC_KEY"), PROJECT_ID)

    # Single use: `unless_exist` makes the write fail for a jti seen before.
    unless Rails.cache.write("devhub:jti:#{claims['jti']}", true, expires_in: 2.minutes, unless_exist: true)
      return render plain: "Magic Login failed: token already used", status: :unauthorized
    end

    user = User.find_by(email: claims["sub"])
    return render plain: "No user #{claims['sub']}", status: :not_found unless user

    # Devise:            sign_in(user)
    # Rails 8 auth gen:  start_new_session_for(user)
    # Custom:            session[:user_id] = user.id
    sign_in(user)
    redirect_to DevhubToken.safe_redirect(claims["redirect"])
  rescue DevhubToken::Error => e
    render plain: "Magic Login failed: #{e.message}", status: :unauthorized
  end
end
