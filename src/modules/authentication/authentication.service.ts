import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { v4 as genUUID } from 'uuid';
import { ExceptionMessageCode } from '../../exceptions/exception-message-code.enum';
import { UserService } from '../user/user.service';
import { AuthenticationPayloadResponseDto } from './dto';
import {
  RecoverPasswordConfirmCodeParams,
  RecoverPasswordParams,
  SignInParams,
  SignUpWithTokenParams,
} from './authentication.types';
import { RandomService } from '../../common/modules/random/random.service';
import { EncoderService } from '../../common/modules/encoder/encoder.service';
import { JwtUtilService } from '../../common/modules/jwt-util/jwt-util.service';
import { AccountVerificationService } from './modules/account-verification/account-verification.service';
import { RecoverPasswordService } from './modules/recover-password/recover-password.service';
import { RefreshTokenService } from './modules/refresh-token/refresh-token.service';

@Injectable()
export class AuthenticationService {
  constructor(
    private readonly userService: UserService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly encoderService: EncoderService,
    private readonly jwtUtilService: JwtUtilService,
    private readonly randomService: RandomService,
    private readonly recoverPasswordService: RecoverPasswordService,
    private readonly accountVerificationService: AccountVerificationService,
  ) {}

  async signUpWithToken(params: SignUpWithTokenParams): Promise<AuthenticationPayloadResponseDto> {
    if (await this.userService.existsByEmail(params.email)) {
      throw new UnauthorizedException(ExceptionMessageCode.USER_EMAIL_EXISTS);
    }

    const { password, ...otherParams } = params;
    const hashedPassword = await this.encoderService.encode(password);
    const user = await this.userService.create({
      ...otherParams,
      isOnline: false,
      profileImagePath: null,
    });
    // passwordHash: hashedPassword,

    const { accessToken, refreshToken } = this.jwtUtilService.generateAuthenticationTokens({
      userId: user.id,
    });
    await this.refreshTokenService.addRefreshTokenByUserId(user.id, refreshToken);

    return { accessToken, refreshToken, hasEmailVerified: false };
  }

  async signInWithToken(params: SignInParams): Promise<AuthenticationPayloadResponseDto> {
    const user = await this.userService.getByEmail(params.email);

    if (!user) {
      throw new UnauthorizedException(ExceptionMessageCode.EMAIL_OR_PASSWORD_INVALID);
    }

    // const passwordMatches = await this.encoderService.matches(params.password, user.passwordHash);

    // if (!passwordMatches) {
    //   throw new UnauthorizedException(ExceptionMessageCode.EMAIL_OR_PASSWORD_INVALID);
    // }

    const { accessToken, refreshToken } = this.jwtUtilService.generateAuthenticationTokens({
      userId: user.id,
    });
    await this.refreshTokenService.addRefreshTokenByUserId(user.id, refreshToken);

    const hasEmailVerified = await this.accountVerificationService.getIsVerifiedByUserId(user.id);

    return { accessToken, refreshToken, hasEmailVerified };
  }

  async refreshToken(oldRefreshToken: string): Promise<AuthenticationPayloadResponseDto> {
    //TODO check only for token validity (not for expiration !) ↓
    const isRefreshTokenValid = await this.jwtUtilService.isRefreshTokenValid(oldRefreshToken);

    if (!isRefreshTokenValid) {
      throw new UnauthorizedException(ExceptionMessageCode.INVALID_TOKEN);
    }

    const userId = await this.refreshTokenService.getUserIdByRefreshToken(oldRefreshToken);

    if (!userId) {
      throw new UnauthorizedException(ExceptionMessageCode.INVALID_TOKEN);
    }

    const user = await this.userService.getById(userId);

    if (!user) {
      const decodedPayload = this.jwtUtilService.getUserPayload(oldRefreshToken);

      if (!decodedPayload) {
        throw new UnauthorizedException(ExceptionMessageCode.INVALID_TOKEN);
      }

      await this.refreshTokenService.clearRefreshTokensForUser(decodedPayload.userId);
      throw new UnauthorizedException(ExceptionMessageCode.REFRESH_TOKEN_REUSE);
    }

    //TODO check for expiration only

    const { accessToken, refreshToken } = this.jwtUtilService.generateAuthenticationTokens({
      userId: user.id,
    });
    await this.refreshTokenService.deleteRefreshToken(oldRefreshToken);
    await this.refreshTokenService.addRefreshTokenByUserId(user.id, refreshToken);

    return { accessToken, refreshToken };
  }

  async recoverPasswordSendVerificationCode(email: string): Promise<void> {
    const user = await this.userService.getByEmail(email);

    if (!user) {
      throw new UnauthorizedException(ExceptionMessageCode.USER_NOT_FOUND);
    }

    const oneTimeCode = this.randomService.generateRandomInt(100000, 999999);

    await this.recoverPasswordService.upsert({
      oneTimeCode,
      userId: user.id,
      isVerified: false,
      uuid: null,
    });

    //TODO send one time code to user on mail
  }

  async recoverPasswordConfirmCode(body: RecoverPasswordConfirmCodeParams): Promise<{ uuid: string }> {
    const { code, email } = body;

    const userId = await this.userService.getIdByEmail(email);

    const recoverPasswordRequest = await this.recoverPasswordService.getByUserId(userId);

    if (recoverPasswordRequest.oneTimeCode !== code) {
      throw new ForbiddenException(ExceptionMessageCode.RECOVER_PASSWORD_REQUEST_INVALID_CODE);
    }

    // if 30 minute is passed
    // if (Date.now() - recoverPasswordRequest.createdAt.getTime() > environment.recoverPasswordRequestTimeoutInMillis) {
    //   throw new ForbiddenException(ExceptionMessageCode.RECOVER_PASSWORD_REQUEST_TIMED_OUT);
    // }

    const uuid = genUUID();

    await this.recoverPasswordService.updateById(recoverPasswordRequest.id, {
      uuid,
      isVerified: true,
    });

    return { uuid };
  }

  async recoverPassword(body: RecoverPasswordParams): Promise<void> {
    const { password, uuid } = body;
    const recoverPasswordRequest = await this.recoverPasswordService.getByUUID(uuid);

    if (!recoverPasswordRequest.isVerified) {
      throw new ForbiddenException(ExceptionMessageCode.RECOVER_PASSWORD_REQUEST_INVALID);
    }

    const hashedPassword = await this.encoderService.encode(password);

    await this.recoverPasswordService.deleteById(uuid);
    // await this.userService.updatePasswordById(recoverPasswordRequest.userId, hashedPassword);
  }

  async sendAccountVerificationCode(userId: number) {
    const oneTimeCode = this.randomService.generateRandomInt(100000, 999999);

    await this.accountVerificationService.upsert({ oneTimeCode, userId });

    //TODO send one time code to user on mail
  }

  async accountVerificationConfirmCode(userId: number, code: number) {
    const accountVerification = await this.accountVerificationService.getByUserId(userId);

    if (!accountVerification) {
      throw new NotFoundException(ExceptionMessageCode.ACCOUNT_VERIFFICATION_REQUEST_NOT_FOUND);
    }

    if (accountVerification.oneTimeCode !== code) {
      throw new ForbiddenException(ExceptionMessageCode.ACCOUNT_VERIFFICATION_REQUEST_INVALID_CODE);
    }

    // if 30 minute is passed
    // if (Date.now() - accountVerification.createdAt.getTime() > environment.accountVerificationRequestTimeoutInMillis) {
    //   throw new ForbiddenException(ExceptionMessageCode.ACCOUNT_VERIFFICATION_REQUEST_TIMED_OUT);
    // }

    await this.accountVerificationService.updateIsVerified(userId, true);
  }
}
