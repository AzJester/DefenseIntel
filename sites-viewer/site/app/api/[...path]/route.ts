import {env} from 'cloudflare:workers';
import {createPublicGateway} from '../../../lib/gateway.mjs';
export const dynamic = 'force-dynamic';
function handle(request: Request) { return createPublicGateway(env)(request); }
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
