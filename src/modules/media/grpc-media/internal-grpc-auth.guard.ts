import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Metadata } from '@grpc/grpc-js';

const INTERNAL_KEY_METADATA_FIELD = 'x-internal-key';

/**
 * MediaInternal.VerifyMedia is reachable by any service on the network — it
 * isn't gated by end-user JWTs. This guard requires callers to present a
 * shared secret in call metadata so an arbitrary caller can't fetch a
 * presigned download URL for someone else's file by guessing/knowing
 * mediaId + uploaderId.
 */
@Injectable()
export class InternalGrpcAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const metadata = context.switchToRpc().getContext<Metadata>();
    const provided = metadata.get(INTERNAL_KEY_METADATA_FIELD)[0];
    const expected = this.config.getOrThrow<string>('INTERNAL_API_KEY');

    if (provided !== expected) {
      throw new UnauthorizedException('Invalid internal service credentials');
    }
    return true;
  }
}
