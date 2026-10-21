declare namespace Cloudflare {
  interface Env {
    SOURCE_SITE_URL?: string;
    SOURCE_SITE_TOKEN?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
