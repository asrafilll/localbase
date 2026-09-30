<?php

namespace App\Http\Controllers;

use App\Models\User;
use App\Support\Devhub\DevhubToken;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use RuntimeException;

/**
 * Local Dev Hub - Magic Login endpoint for Laravel.
 *
 * Register it ONLY in the local environment (routes/web.php):
 *
 *   if (app()->environment('local') && config('services.devhub.public_key')) {
 *       Route::get('/__devhub/login', \App\Http\Controllers\DevhubLoginController::class);
 *   }
 *
 * config/services.php:
 *
 *   'devhub' => [
 *       'public_key' => env('DEVHUB_PUBLIC_KEY'),
 *       'project' => env('DEVHUB_PROJECT', 'fitbase'), // id from .dev/project.yaml
 *   ],
 */
final class DevhubLoginController
{
    public function __invoke(Request $request)
    {
        // Defense in depth: even if the route leaks into another environment, refuse.
        abort_unless(app()->environment('local') && config('services.devhub.public_key'), 404);

        try {
            $claims = DevhubToken::verify(
                (string) $request->query('token'),
                config('services.devhub.public_key'),
                config('services.devhub.project'),
            );
        } catch (RuntimeException $e) {
            abort(401, $e->getMessage());
        }

        // Single use: Cache::add only succeeds for the first request with this jti.
        abort_unless(Cache::add('devhub:jti:'.$claims['jti'], true, 120), 401, 'Token already used');

        $user = User::where('email', $claims['sub'])->firstOrFail();
        Auth::login($user);
        $request->session()->regenerate();

        return redirect(DevhubToken::safeRedirect($claims['redirect'] ?? null));
    }
}
