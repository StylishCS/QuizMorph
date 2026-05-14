import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthGoogleService } from './auth-google.service';

@Controller('auth')
export class AuthController {
  private readonly log = new Logger(AuthController.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly authGoogle: AuthGoogleService,
  ) {}

  @Get('google')
  googleAuth(@Res() res: FastifyReply) {
    const url = this.authGoogle.buildAuthorizationUrl();
    this.log.log('[googleAuth] redirect to Google consent screen');
    return res.redirect(302, url);
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('error') oauthError: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: FastifyReply,
  ) {
    const base = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    if (oauthError) {
      const msg = errorDescription ?? oauthError;
      this.log.warn(`[googleCallback] OAuth error from Google: ${msg}`);
      return res.redirect(302, `${base}/auth/callback?error=${encodeURIComponent(msg)}`);
    }
    if (!code) {
      this.log.warn('[googleCallback] missing code, redirecting with error');
      return res.redirect(
        302,
        `${base}/auth/callback?error=${encodeURIComponent('missing_oauth_code')}`,
      );
    }

    try {
      this.log.log('[googleCallback] exchanging code for tokens');
      const { userId } = await this.authGoogle.exchangeCodeAndUpsertUser(code);
      const token = this.jwt.sign({ sub: userId });
      this.log.log(`[googleCallback] success userId=${userId} jwtIssued=true`);
      const url = `${base}/auth/callback?token=${encodeURIComponent(token)}`;
      return res.redirect(302, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'oauth_callback_failed';
      this.log.error(`[googleCallback] exchange failed: ${msg}`, err instanceof Error ? err.stack : undefined);
      return res.redirect(302, `${base}/auth/callback?error=${encodeURIComponent(msg)}`);
    }
  }
}
