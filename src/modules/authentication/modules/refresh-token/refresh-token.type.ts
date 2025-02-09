import { PlatformForJwt } from '@prisma/client';
import { RefreshTokenClaims } from '@global/jwt';

export type CreateRefreshTokenParams = {
  userId: number;
  token: string;
  platform: PlatformForJwt;
} & RefreshTokenClaims;
