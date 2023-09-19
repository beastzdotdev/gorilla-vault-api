import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NoAuth } from '../../decorator/no-auth.decorator';
import { AuthenticationService } from './authentication.service';
import { RecoverpasswordConfirmCodePayloadDto } from './dto/recover-password-confirm-code-payload.dto';
import { Response } from 'express';
import { AuthPlatformHeaderGuard } from './guard/auth-platform-header.guard';
import { PlatformHeader } from '../../decorator/platform-header.decorator';
import { CookieStrict } from '../../decorator/cookie-decorator';
import { Constants } from '../../common/constants';
import { PlatformWrapper } from '../../model/platform.wrapper';
import { AccountVerifySendCodeDto } from './dto/account-verify-send-code.dto';
import { NoPlatformHeader } from '../../decorator/no-platform-header.decorator';
import {
  AccountVerificationConfirmCodeQueryDto,
  RecoverPasswordConfirmCodeBodyDto,
  RecoverPasswordDto,
  RecoverPasswordSendVerificationCodeBodyDto,
  RefreshTokenBodyDto,
  SignInBodyDto,
  SignUpBodyDto,
} from './dto';

@UseGuards(AuthPlatformHeaderGuard)
@Controller('authentication')
export class AuthenticationController {
  constructor(private readonly authenticationService: AuthenticationService) {}

  @NoAuth()
  @Post('sign-up')
  async signUp(
    @Body() body: SignUpBodyDto,
    @Res() res: Response,
    @PlatformHeader() platform: PlatformWrapper,
  ): Promise<Response> {
    return this.authenticationService.signUpWithToken(res, body, platform);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('sign-in')
  async signIn(
    @Body() body: SignInBodyDto,
    @Res() res: Response,
    @PlatformHeader() platform: PlatformWrapper,
  ): Promise<Response> {
    return this.authenticationService.signInWithToken(res, body, platform);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refreshByCookie(
    @Res() res: Response,
    @PlatformHeader() platform: PlatformWrapper,
    @CookieStrict({
      cookieName: Constants.COOKIE_REFRESH_NAME,
      cls: UnauthorizedException,
      message: 'Missing refresh token',
    })
    refreshToken?: string,
  ): Promise<Response> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing token');
    }

    return this.authenticationService.refreshToken(res, { oldRefreshTokenString: refreshToken }, platform);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('refresh/by-body')
  async refreshByBody(
    @Body() body: RefreshTokenBodyDto,
    @Res() res: Response,
    @PlatformHeader() platform: PlatformWrapper,
  ): Promise<Response> {
    return this.authenticationService.refreshToken(res, { oldRefreshTokenString: body.refreshToken }, platform);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('recover-password/send-verification-code')
  async recoverPasswordSendVerificationCode(@Body() body: RecoverPasswordSendVerificationCodeBodyDto): Promise<void> {
    await this.authenticationService.recoverPasswordSendVerificationCode(body.email);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('recover-password/confirm-code')
  async recoverPasswordConfirmCode(
    @Body() body: RecoverPasswordConfirmCodeBodyDto,
  ): Promise<RecoverpasswordConfirmCodePayloadDto> {
    return this.authenticationService.recoverPasswordConfirmCode(body);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('recover-password')
  async recoverPassword(@Body() body: RecoverPasswordDto): Promise<void> {
    await this.authenticationService.recoverPassword(body);
  }

  @NoAuth()
  @HttpCode(HttpStatus.OK)
  @Post('account-verify/send-code')
  async sendAccountVerificationCode(
    @Body() body: AccountVerifySendCodeDto,
    @PlatformHeader() platform: PlatformWrapper,
  ) {
    await this.authenticationService.sendAccountVerificationCode(body.email, platform);
  }

  @NoAuth()
  @NoPlatformHeader()
  @HttpCode(HttpStatus.OK)
  @Get('account-verify/confirm-code')
  async accountVerificationConfirmCode(@Query() body: AccountVerificationConfirmCodeQueryDto) {
    await this.authenticationService.accountVerificationConfirmCode(body);
  }
}
