import bcrypt from 'bcrypt';
import moment from 'moment';
import { v4 as uuid } from 'uuid';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';

import { random } from '../../common/random';
import { constants } from '../../common/constants';
import { encryption } from '../../common/encryption';
import { UserService } from '../user/user.service';
import { JwtService } from './modules/jwt/jwt.service';
import { EnvService } from '../@global/env/env.service';
import { InjectEnv } from '../@global/env/env.decorator';
import { CookieService } from '../@global/cookie/cookie.service';
import { PlatformWrapper } from '../../model/platform.wrapper';
import { ResetPasswordBodyDto } from './dto/reset-password-body.dto';
import { ResetPasswordService } from './modules/reset-password/reset-password.service';
import { AccountVerificationService } from './modules/account-verification/account-verification.service';
import { RecoverPasswordService } from './modules/recover-password/recover-password.service';
import { RefreshTokenService } from './modules/refresh-token/refresh-token.service';
import { UserIdentityService } from '../user-identity/user-identity.service';
import { TokenExpiredException } from '../../exceptions/token-expired-forbidden.exception';
import { RefreshTokenExpiredException } from '../../exceptions/refresh-token-expired.exception';
import { ExceptionMessageCode } from '../../model/enum/exception-message-code.enum';
import { RecoverPasswordAttemptCountService } from './modules/recover-password-attempt-count/recover-password-attempt-count.service';
import { AccountVerificationAttemptCountService } from './modules/account-verification-attempt-count/account-verification-attempt-count.service';
import { RefreshParams, SignInParams, SignUpWithTokenParams } from './authentication.types';
import { ResetPasswordAttemptCountService } from './modules/reset-password-attempt-count/reset-password-attempt-count.service';
import { AuthConfirmQueryDto, AuthenticationPayloadResponseDto } from './dto';

@Injectable()
export class AuthenticationService {
  constructor(
    @InjectEnv()
    private readonly envService: EnvService,

    private readonly cookieService: CookieService,
    private readonly userService: UserService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly jwtUtilService: JwtService,
    private readonly recoverPasswordService: RecoverPasswordService,
    private readonly accountVerificationService: AccountVerificationService,
    private readonly userIdentityService: UserIdentityService,
    private readonly recoverPasswordAttemptCountService: RecoverPasswordAttemptCountService,
    private readonly accVerifyAttemptCountService: AccountVerificationAttemptCountService,
    private readonly resetPasswordService: ResetPasswordService,
    private readonly resetPasswordAttemptCountService: ResetPasswordAttemptCountService,
  ) {}

  async signUpWithToken(res: Response, params: SignUpWithTokenParams, platform: PlatformWrapper): Promise<Response> {
    if (await this.userService.existsByEmail(params.email)) {
      throw new UnauthorizedException(ExceptionMessageCode.USER_EMAIL_EXISTS);
    }

    const { password, ...otherParams } = params;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.userService.create({
      ...otherParams,
      isOnline: false,
      profileImagePath: null,
    });

    await this.userIdentityService.create({
      userId: user.id,
      password: hashedPassword,
    });

    return this.genTokensAndSendResponse({
      res,
      platform,
      isAccountVerified: false,
      email: user.email,
      userId: user.id,
    });
  }

  async signInWithToken(res: Response, params: SignInParams, platform: PlatformWrapper): Promise<Response> {
    const user = await this.userService.getByEmailIncludeIdentity(params.email);
    this.userService.validateUser(user, { showNotVerifiedErr: true });

    const passwordMatches = await bcrypt.compare(params.password, user.userIdentity.password);

    if (!passwordMatches) {
      throw new UnauthorizedException(ExceptionMessageCode.EMAIL_OR_PASSWORD_INVALID);
    }

    return this.genTokensAndSendResponse({
      res,
      platform,
      email: user.email,
      userId: user.id,
      isAccountVerified: user.userIdentity.isAccountVerified,
    });
  }

  async refreshToken(res: Response, params: RefreshParams, platform: PlatformWrapper): Promise<Response> {
    const { oldRefreshTokenString } = params;

    // Decrypt is session is enabled
    const isEncryptionSessionActive = this.envService.get('ENABLE_SESSION_ACCESS_JWT_ENCRYPTION');
    const key = this.envService.get('SESSION_ACCESS_JWT_ENCRYPTION_KEY');

    const finalOldRefreshTokenString = isEncryptionSessionActive
      ? await encryption.aes256gcm.decrypt(oldRefreshTokenString, key)
      : oldRefreshTokenString;

    if (!finalOldRefreshTokenString) {
      throw new UnauthorizedException(ExceptionMessageCode.INVALID_TOKEN);
    }

    const refreshTokenPayload = this.jwtUtilService.getRefreshTokenPayload(finalOldRefreshTokenString);
    const refreshTokenFromDB = await this.refreshTokenService.getByJTI(refreshTokenPayload.jti);

    // validate user existence from token
    const user = await this.userService.getByIdIncludeIdentity(refreshTokenPayload.userId);
    this.userService.validateUser(user, { showNotVerifiedErr: true });

    // validate signature only (very important)
    await this.jwtUtilService.validateRefreshTokenSignatureOnly(finalOldRefreshTokenString);

    // detect refresh token reuse
    if (!refreshTokenFromDB) {
      await this.refreshTokenService.deleteAllByUserId(user.id);

      const userIdentity = await this.userIdentityService.getByUserId(user.id);

      // send email here (delete comment after) update lock and please reset password (password reset optional)

      if (userIdentity.strictMode) {
        await this.userIdentityService.updateIsLockedById(userIdentity.id, true);
      }

      throw new UnauthorizedException(ExceptionMessageCode.REFRESH_TOKEN_REUSE);
    }

    // validate fully
    try {
      await this.jwtUtilService.validateRefreshToken(finalOldRefreshTokenString, {
        ...refreshTokenFromDB,
        exp: parseInt(refreshTokenFromDB.exp),
        iat: parseInt(refreshTokenFromDB.iat),
      });
    } catch (error) {
      // catch general token expired error, update is used if refresh token is correct and expired
      if (error instanceof TokenExpiredException) {
        await this.refreshTokenService.deleteById(refreshTokenFromDB.id);
        throw new RefreshTokenExpiredException();
      }

      throw error;
    }

    return this.genTokensAndSendResponse({
      res,
      platform,
      email: user.email,
      userId: user.id,
      isAccountVerified: user.userIdentity.isAccountVerified,
    });
  }

  async resetPasswordSend(body: ResetPasswordBodyDto, userId: number): Promise<void> {
    const { newPassword, oldPassword } = body;

    // we should not let user know that user not exists than user will use this info for password
    const user = await this.userService.getByIdIncludeIdentity(userId);
    const passwordMatches = await bcrypt.compare(oldPassword, user.userIdentity.password);

    if (!passwordMatches) {
      throw new UnauthorizedException(ExceptionMessageCode.PASSWORD_INVALID);
    }

    if (oldPassword === newPassword) {
      throw new UnauthorizedException(ExceptionMessageCode.NEW_PASSWORD_SAME);
    }

    this.userService.validateUser(user, { showNotVerifiedErr: true });

    const { email } = user;
    const jti = uuid();
    const securityToken = this.jwtUtilService.genResetPasswordToken({ email, userId, jti });
    const newPasswordHashed = await bcrypt.hash(newPassword, 10);

    let resetPassword = await this.resetPasswordService.getByUserId(user.id);

    if (resetPassword) {
      resetPassword = await this.resetPasswordService.updateById(resetPassword.id, {
        securityToken,
        newPassword: newPasswordHashed,
        jti,
      });
    } else {
      resetPassword = await this.resetPasswordService.create({
        userId,
        securityToken,
        newPassword: newPasswordHashed,
        jti,
      });
    }

    let resetPasswordAttemptCount = await this.resetPasswordAttemptCountService.getByResetPasswordId(resetPassword.id);

    if (!resetPasswordAttemptCount) {
      resetPasswordAttemptCount = await this.resetPasswordAttemptCountService.create({
        resetPasswordId: resetPassword.id,
      });
    } else {
      const { count, countIncreaseLastUpdateDate } = resetPasswordAttemptCount;
      const today = moment();

      if (count < 5) {
        await this.resetPasswordAttemptCountService.updateById(resetPasswordAttemptCount.id, {
          count: count + 1,
          countIncreaseLastUpdateDate: today.toDate(),
        });

        return;
      }

      // if attempt is max and one day is not gone by at least throw error
      // count >= 5 and less then one day passed
      if (today.diff(countIncreaseLastUpdateDate, 'seconds') <= constants.ONE_DAY_IN_SEC) {
        throw new ForbiddenException('Please wait for another day to recover password');
      }

      await this.resetPasswordAttemptCountService.updateById(resetPasswordAttemptCount.id, {
        count: 0,
        countIncreaseLastUpdateDate: today.toDate(),
      });
    }

    // send token url on email
  }

  async recoverPasswordSend(email: string): Promise<void> {
    const user = await this.userService.getByEmailIncludeIdentity(email);
    this.userService.validateUser(user, { showNotVerifiedErr: true });

    const { id: userId } = user;
    const jti = uuid();
    const securityToken = this.jwtUtilService.genRecoverPasswordToken({ email, userId, jti });
    const newPasswordText = random.generateRandomInt(100000, 999999).toString();
    const newPasswordHashed = await bcrypt.hash(newPasswordText, 10);

    let recoverPassword = await this.recoverPasswordService.getByUserId(user.id);

    if (recoverPassword) {
      recoverPassword = await this.recoverPasswordService.updateById(recoverPassword.id, {
        securityToken,
        newPassword: newPasswordHashed,
        jti,
      });
    } else {
      recoverPassword = await this.recoverPasswordService.create({
        userId,
        securityToken,
        newPassword: newPasswordHashed,
        jti,
      });
    }

    let recoverPasswordAttemptCount = await this.recoverPasswordAttemptCountService.getByRecoverPasswordId(
      recoverPassword.id,
    );

    if (!recoverPasswordAttemptCount) {
      recoverPasswordAttemptCount = await this.recoverPasswordAttemptCountService.create({
        recoverPasswordId: recoverPassword.id,
      });
    } else {
      const { count, countIncreaseLastUpdateDate } = recoverPasswordAttemptCount;
      const today = moment();

      if (count < 5) {
        await this.recoverPasswordAttemptCountService.updateById(recoverPasswordAttemptCount.id, {
          count: count + 1,
          countIncreaseLastUpdateDate: today.toDate(),
        });

        return;
      }

      // if attempt is max and one day is not gone by at least throw error
      // count >= 5 and less then one day passed
      if (today.diff(countIncreaseLastUpdateDate, 'seconds') <= constants.ONE_DAY_IN_SEC) {
        throw new ForbiddenException('Please wait for another day to recover password');
      }

      await this.recoverPasswordAttemptCountService.updateById(recoverPasswordAttemptCount.id, {
        count: 0,
        countIncreaseLastUpdateDate: today.toDate(),
      });
    }

    // send token url on email
  }

  async accountVerifySend(email: string): Promise<void> {
    const user = await this.userService.getByEmailIncludeIdentity(email);
    this.userService.validateUser(user, { showIsVerifiedErr: true });

    const { id: userId } = user;
    const jti = uuid();
    const securityToken = this.jwtUtilService.genAccountVerifyToken({ email, userId, jti });

    let accountVerify = await this.accountVerificationService.getByUserId(userId);

    if (accountVerify) {
      accountVerify = await this.accountVerificationService.updateById(accountVerify.id, { securityToken, jti });
    } else {
      accountVerify = await this.accountVerificationService.create({ userId, securityToken, jti });
    }

    let accVerifyAttemptCount = await this.accVerifyAttemptCountService.getByAccVerifyId(accountVerify.id);

    if (!accVerifyAttemptCount) {
      accVerifyAttemptCount = await this.accVerifyAttemptCountService.create({
        accountVerificationId: accountVerify.id,
      });
    } else {
      const { count, countIncreaseLastUpdateDate } = accVerifyAttemptCount;
      const today = moment();

      if (count < 5) {
        await this.accVerifyAttemptCountService.updateById(accVerifyAttemptCount.id, {
          count: count + 1,
          countIncreaseLastUpdateDate: today.toDate(),
        });

        return;
      }

      // if attempt is max and one day is not gone by at least throw error
      // count >= 5 and less then one day passed
      if (today.diff(countIncreaseLastUpdateDate, 'seconds') <= constants.ONE_DAY_IN_SEC) {
        throw new ForbiddenException('Please wait for another day to recover password');
      }

      await this.accVerifyAttemptCountService.updateById(accVerifyAttemptCount.id, {
        count: 0,
        countIncreaseLastUpdateDate: today.toDate(),
      });
    }

    // send token url on email
  }

  async resetPasswordConfirm(body: AuthConfirmQueryDto): Promise<void> {
    const { token } = body;
    const { jti, userId } = this.jwtUtilService.getResetPasswordTokenPayload(token);

    const user = await this.userService.getByIdIncludeIdentity(userId);

    // reuse detection
    const resetPasswordByJti = await this.resetPasswordService.getByJTI(jti);

    // reuse will be if deleted token is used and more than 1 day is gone
    if (resetPasswordByJti && resetPasswordByJti?.deletedAt) {
      const attemptCount = await this.resetPasswordAttemptCountService.getByResetPasswordId(resetPasswordByJti.id, {
        includeDeleted: true,
      });

      if (!attemptCount) {
        throw new InternalServerErrorException('This should not happen');
      }

      const now = moment().toDate();
      const tommorowFromCreation = moment(attemptCount.countIncreaseLastUpdateDate).add(
        constants.ONE_DAY_IN_SEC,
        'seconds',
      );

      // when now is more than x (x is date of auth creation date)
      if (tommorowFromCreation.diff(now, 'seconds') < 0) {
        // send email here (delete comment after)

        if (user.userIdentity.strictMode) {
          await this.userIdentityService.updateIsLockedById(user.userIdentity.id, true);
        }

        throw new ForbiddenException(ExceptionMessageCode.RESET_PASSWORD_TOKEN_REUSE);
      }
    }

    const resetPassword = await this.resetPasswordService.getByUserId(userId);

    if (!resetPassword) {
      throw new NotFoundException(ExceptionMessageCode.RESET_PASSWORD_REQUEST_NOT_FOUND);
    }

    if (token !== resetPassword.securityToken) {
      throw new ForbiddenException(ExceptionMessageCode.RESET_PASSWORD_REQUEST_INVALID);
    }

    this.userService.validateUser(user, { showNotVerifiedErr: true });

    await this.jwtUtilService.validateResetPasswordToken(token, {
      sub: user.email,
      userId: user.id,
      jti: resetPassword.jti,
    });

    await Promise.all([
      this.userIdentityService.updatePasswordById(userId, resetPassword.newPassword),
      this.resetPasswordService.softDelete(resetPassword.id),
      this.resetPasswordAttemptCountService.softDelete(resetPassword.id),
    ]);

    // show success page and button for redirecting to front end
  }

  async recoverPasswordConfirm(body: AuthConfirmQueryDto): Promise<void> {
    const { token } = body;
    const { jti, userId } = this.jwtUtilService.getRecoverPasswordTokenPayload(token);

    const user = await this.userService.getByIdIncludeIdentity(userId);

    // reuse detection
    const recoverPasswordByJti = await this.recoverPasswordService.getByJTI(jti);

    // reuse will be if deleted token is used and more than 1 day is gone
    if (recoverPasswordByJti && recoverPasswordByJti?.deletedAt) {
      const attemptCount = await this.recoverPasswordAttemptCountService.getByRecoverPasswordId(
        recoverPasswordByJti.id,
        {
          includeDeleted: true,
        },
      );

      if (!attemptCount) {
        throw new InternalServerErrorException('This should not happen');
      }

      const now = moment().toDate();
      const tommorowFromCreation = moment(attemptCount.countIncreaseLastUpdateDate).add(
        constants.ONE_DAY_IN_SEC,
        'seconds',
      );

      // when now is more than x (x is date of auth creation date)
      if (tommorowFromCreation.diff(now, 'seconds') < 0) {
        // send email here (delete comment after)

        if (user.userIdentity.strictMode) {
          await this.userIdentityService.updateIsLockedById(user.userIdentity.id, true);
        }

        throw new ForbiddenException(ExceptionMessageCode.RECOVER_PASSWORD_TOKEN_REUSE);
      }
    }

    const recoverPassword = await this.recoverPasswordService.getByUserId(userId);

    if (!recoverPassword) {
      throw new NotFoundException(ExceptionMessageCode.RECOVER_PASSWORD_REQUEST_NOT_FOUND);
    }

    if (token !== recoverPassword.securityToken) {
      throw new ForbiddenException(ExceptionMessageCode.RECOVER_PASSWORD_REQUEST_INVALID);
    }

    this.userService.validateUser(user, { showNotVerifiedErr: true });

    await this.jwtUtilService.validateRecoverPasswordToken(token, {
      sub: user.email,
      userId: user.id,
      jti: recoverPassword.jti,
    });

    await Promise.all([
      this.userIdentityService.updatePasswordById(userId, recoverPassword.newPassword),
      this.recoverPasswordService.softDelete(recoverPassword.id),
      this.recoverPasswordAttemptCountService.softDelete(recoverPassword.id),
    ]);

    // show success page and button for redirecting to front end
  }

  async accountVerificationConfirm(body: AuthConfirmQueryDto): Promise<void> {
    const { token } = body;
    const { jti, userId } = this.jwtUtilService.getAccountVerifyTokenPayload(token);

    const user = await this.userService.getByIdIncludeIdentity(userId);

    // reuse detection
    const accountVerifyByJti = await this.accountVerificationService.getByJTI(jti);

    // reuse will be if deleted token is used and more than 1 day is gone
    if (accountVerifyByJti && accountVerifyByJti?.deletedAt) {
      const attemptCount = await this.accVerifyAttemptCountService.getByAccVerifyId(accountVerifyByJti.id, {
        includeDeleted: true,
      });

      if (!attemptCount) {
        throw new InternalServerErrorException('This should not happen');
      }

      const now = moment().toDate();
      const tommorowFromCreation = moment(attemptCount.countIncreaseLastUpdateDate).add(
        constants.ONE_DAY_IN_SEC,
        'seconds',
      );

      // when now is more than x (x is date of auth creation date)
      if (tommorowFromCreation.diff(now, 'seconds') < 0) {
        // send email here (delete comment after)

        if (user.userIdentity.strictMode) {
          await this.userIdentityService.updateIsLockedById(user.userIdentity.id, true);
        }

        throw new ForbiddenException(ExceptionMessageCode.ACCOUNT_VERIFICATION_TOKEN_REUSE);
      }
    }

    const accountVerify = await this.accountVerificationService.getByUserId(userId);

    if (!accountVerify) {
      throw new NotFoundException(ExceptionMessageCode.ACCOUNT_VERIFICATION_REQUEST_NOT_FOUND);
    }

    if (token !== accountVerify.securityToken) {
      throw new ForbiddenException(ExceptionMessageCode.ACCOUNT_VERIFICATION_REQUEST_INVALID);
    }

    this.userService.validateUser(user, { showIsVerifiedErr: true });

    await this.jwtUtilService.validateAccountVerifyToken(token, {
      sub: user.email,
      userId: user.id,
      jti: accountVerify.jti,
    });

    await Promise.all([
      this.userIdentityService.updateIsAccVerified(userId, true),
      this.accountVerificationService.softDelete(accountVerify.id),
      this.accVerifyAttemptCountService.softDelete(accountVerify.id),
    ]);

    // show success page and button for redirecting to front end
  }

  private async genTokensAndSendResponse(params: {
    res: Response;
    userId: number;
    email: string;
    platform: PlatformWrapper;
    isAccountVerified: boolean;
  }): Promise<Response> {
    const { platform, res, isAccountVerified, email, userId } = params;

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtUtilService.genRefreshToken({ userId, email }),
      this.jwtUtilService.genAccessToken({ userId, email }),
    ]);

    const refreshTokenPayload = this.jwtUtilService.getRefreshTokenPayload(refreshToken);

    const isEncryptionSessionActive = this.envService.get('ENABLE_SESSION_ACCESS_JWT_ENCRYPTION');
    const key = this.envService.get('SESSION_ACCESS_JWT_ENCRYPTION_KEY');

    const [finalAccessToken, finalRefreshToken] = await Promise.all([
      isEncryptionSessionActive ? await encryption.aes256gcm.encrypt(accessToken, key) : accessToken,
      isEncryptionSessionActive ? await encryption.aes256gcm.encrypt(refreshToken, key) : refreshToken,
      this.refreshTokenService.addRefreshTokenByUserId({ ...refreshTokenPayload, token: refreshToken }),
    ]);

    if (platform.isWeb()) {
      this.cookieService.createCookie(res, {
        accessToken: finalAccessToken,
        refreshToken: finalRefreshToken,
      });

      return res.json(<Partial<AuthenticationPayloadResponseDto>>{ isAccountVerified });
    }

    if (platform.isMobile()) {
      return res.json(<AuthenticationPayloadResponseDto>{
        accessToken: finalAccessToken,
        refreshToken: finalRefreshToken,
        isAccountVerified,
      });
    }

    return res.json({ msg: 'Something went wrong' }).status(500);
  }
}
