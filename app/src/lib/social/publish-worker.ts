import type { Queryable } from '@/lib/seo/run-audit';
import { contentHash } from './hash';
import type { SocialProvider } from './provider';
import type { Network } from './types';

/**
 * Server-side publishing worker. It must run with SERVER credentials (the service role): the
 * database refuses these writes from anyone using the app.
 *
 * What makes it safe:
 *  1. It only touches posts already in "publishing", which the database only allows for posts
 *     that were approved and whose text still matches the approval fingerprint.
 *  2. It CLAIMS each attempt by inserting a row that is unique per (post, attempt number). If two
 *     workers race, exactly one insert succeeds; the other stands down without publishing.
 *  3. It re-checks the fingerprint itself before contacting the provider.
 *  4. It sends the same idempotency key for every attempt at one post.
 *  5. The outcome is saved in ONE statement, so a crash cannot leave a half-recorded result.
 *  6. People only ever see short, plain messages - never raw provider or database errors.
 *
 * The CALLER must have checked that the person who asked is allowed to publish; this function
 * trusts the post id it is given.
 */

export type PublishOutcome =
  | { postId: string; status: 'published' }
  | { postId: string; status: 'failed'; message: string }
  | { postId: string; status: 'skipped'; reason: 'already_claimed' | 'not_publishing' };

const TEXT_CHANGED = 'The text no longer matches what was approved, so it was not published.';
const UNEXPECTED = 'Something went wrong while publishing. It is safe to try again.';

interface PostRow {
  id: string; workspace_id: string; status: string; body: string; image_alt: string | null;
  approved_hash: string | null; attempt_count: number; channel_id: string; external_id: string; network: Network;
}

export async function processPost(db: Queryable, postId: string, provider: SocialProvider): Promise<PublishOutcome> {
  const { rows } = await db.query<PostRow>(
    `select p.id, p.workspace_id, p.status::text as status, p.body, p.image_alt, p.approved_hash, p.attempt_count,
            p.channel_id, c.external_id, c.network::text as network
       from public.social_posts p join public.social_channels c on c.id = p.channel_id where p.id = $1`,
    [postId],
  );
  const post = rows[0];
  if (!post || post.status !== 'publishing') return { postId, status: 'skipped', reason: 'not_publishing' };

  // Claim this attempt. Losing the race is normal and harmless.
  const claim = await db.query(
    `insert into public.social_publish_attempts (post_id, workspace_id, attempt_no, idempotency_key)
     values ($1, $2, $3, $4) on conflict (post_id, attempt_no) do nothing returning id`,
    [post.id, post.workspace_id, post.attempt_count, `post:${post.id}`],
  );
  if (claim.rows.length === 0) return { postId, status: 'skipped', reason: 'already_claimed' };

  const finish = async (kind: 'published' | 'failed', attemptResult: 'success' | 'failed' | 'rate_limited', code: string | null, message: string | null, externalPostId?: string) => {
    // ONE statement: record the attempt and move the post, together or not at all.
    await db.query(
      `with a as (
         update public.social_publish_attempts set result = $3::public.social_publish_result, error_code = $4, error_message = $5
          where post_id = $1 and attempt_no = $2 and finished_at is null returning 1
       )
       update public.social_posts
          set status = $6::public.social_post_status, external_post_id = $7, last_error = $8
        where id = $1 and status = 'publishing' and (select count(*) from a) >= 0`,
      [post.id, post.attempt_count, attemptResult, code, message, kind, externalPostId ?? null, kind === 'failed' ? message : null],
    );
  };

  if (contentHash(post.channel_id, post.body, post.image_alt) !== post.approved_hash) {
    await finish('failed', 'failed', 'text_changed', TEXT_CHANGED);
    return { postId, status: 'failed', message: TEXT_CHANGED };
  }

  try {
    const result = await provider.publish({
      idempotencyKey: `post:${post.id}`, channelExternalId: post.external_id, network: post.network, body: post.body, imageAlt: post.image_alt,
    });
    if (result.ok) {
      await finish('published', 'success', null, null, result.externalPostId);
      return { postId, status: 'published' };
    }
    await finish('failed', result.code === 'rate_limited' ? 'rate_limited' : 'failed', result.code, result.message);
    return { postId, status: 'failed', message: result.message };
  } catch {
    await finish('failed', 'failed', 'unexpected', UNEXPECTED);
    return { postId, status: 'failed', message: UNEXPECTED };
  }
}

/** Move scheduled posts whose time has come to "publishing". Returns the ones that started. */
export async function startDuePosts(db: Queryable, limit = 20): Promise<{ started: string[]; skipped: { postId: string; reason: string }[] }> {
  const { rows } = await db.query<{ id: string }>(
    `select id from public.social_posts where status = 'scheduled' and scheduled_at <= now() order by scheduled_at limit $1`,
    [limit],
  );
  const started: string[] = [];
  const skipped: { postId: string; reason: string }[] = [];
  for (const { id } of rows) {
    try {
      // The channel check is part of the statement, so a paused channel is a normal "not this time",
      // not an error. The post stays scheduled and is picked up once the channel is active again.
      const r = await db.query(
        `update public.social_posts p set status = 'publishing'
          where p.id = $1 and p.status = 'scheduled' and p.attempt_count < 3
            and exists (select 1 from public.social_channels c where c.id = p.channel_id and c.status = 'active')
          returning p.id`,
        [id],
      );
      if (r.rows.length) started.push(id);
      else skipped.push({ postId: id, reason: 'The channel is not active, so the post was not started.' });
    } catch {
      skipped.push({ postId: id, reason: 'The post could not be started. It stays scheduled.' });
    }
  }
  return { started, skipped };
}

/**
 * A worker that crashes after claiming leaves a post "publishing" for ever. Fail such posts so
 * a person can look. The message is honest: the post MAY have gone out, so check the channel
 * before trying again (retries reuse the same idempotency key, so a provider that supports it
 * will not post twice).
 */
export async function failStalePublishing(db: Queryable, olderThanMinutes = 15): Promise<number> {
  const { rows } = await db.query(
    `update public.social_posts
        set status = 'failed', last_error = 'We could not confirm whether this was published. Please check the channel before trying again.'
      where status = 'publishing' and updated_at < now() - make_interval(mins => $1::int)
      returning id`,
    [olderThanMinutes],
  );
  return rows.length;
}
