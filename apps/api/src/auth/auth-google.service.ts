import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google } from 'googleapis';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthGoogleService {
  private readonly log = new Logger(AuthGoogleService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private oauth2Client() {
    const clientId = this.config.getOrThrow<string>('GOOGLE_CLIENT_ID');
    const clientSecret = this.config.getOrThrow<string>('GOOGLE_CLIENT_SECRET');
    const redirectUri =
      this.config.get<string>('GOOGLE_CALLBACK_URL') ?? 'http://localhost:3001/auth/google/callback';
    return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  }

  buildAuthorizationUrl(): string {
    const oauth2 = this.oauth2Client();
    return oauth2.generateAuthUrl({
      scope: [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/forms.body',
        'https://www.googleapis.com/auth/drive.file',
      ],
      access_type: 'offline',
      prompt: 'consent',
    });
  }

  async exchangeCodeAndUpsertUser(code: string): Promise<{ userId: string }> {
    this.log.log('[exchangeCodeAndUpsertUser] getToken + userinfo');
    const oauth2 = this.oauth2Client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.access_token) {
      throw new BadRequestException('Google did not return an access token');
    }
    this.log.debug(
      `[exchangeCodeAndUpsertUser] hasRefreshToken=${Boolean(tokens.refresh_token)}`,
    );
    oauth2.setCredentials(tokens);

    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const { data } = await oauth2Api.userinfo.get();
    if (!data.id || !data.email) {
      throw new BadRequestException('Google profile is missing id or email');
    }

    const user = await this.prisma.user.upsert({
      where: { googleId: data.id },
      create: {
        googleId: data.id,
        email: data.email,
        ...(tokens.refresh_token ? { googleRefreshToken: tokens.refresh_token } : {}),
      },
      update: {
        email: data.email,
        ...(tokens.refresh_token ? { googleRefreshToken: tokens.refresh_token } : {}),
      },
    });

    this.log.log(
      `[exchangeCodeAndUpsertUser] upsert ok userId=${user.id} googleId=${data.id} email=${data.email}`,
    );

    return { userId: user.id };
  }
}
