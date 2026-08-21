create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null default 'UTC',
  locale text not null default 'en-US',
  notification_preferences jsonb not null default '{}'::jsonb,
  privacy_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, timezone, locale)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(coalesce(new.email, 'LocalClear user'), '@', 1)),
    coalesce(nullif(new.raw_user_meta_data ->> 'timezone', ''), 'UTC'),
    coalesce(nullif(new.raw_user_meta_data ->> 'locale', ''), 'en-US')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create table public.households (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  goal text not null default 'sell_few_items' check (goal in ('sell_few_items', 'clear_a_space')),
  zip_code text not null check (zip_code ~ '^\d{5}(-\d{4})?$'),
  selling_radius_miles integer not null check (selling_radius_miles between 1 and 250),
  exchange_preferences text[] not null,
  payment_wording text not null check (
    payment_wording in ('cash_preferred', 'external_apps_accepted', 'decide_at_meetup')
  ),
  availability jsonb not null default '[]'::jsonb,
  preferred_meetup_locations jsonb not null default '[]'::jsonb,
  price_rules jsonb not null default '{"defaultMinimumOfferPercent":70,"defaultHoldMinutes":120,"acceptsTrades":false}'::jsonb,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create or replace function public.is_household_member(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members member
    where member.household_id = target_household_id
      and member.user_id = auth.uid()
  );
$$;

create table public.seller_devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 120),
  public_key text not null check (char_length(public_key) >= 32),
  android_version integer not null check (android_version >= 11),
  app_version text not null,
  is_primary boolean not null default false,
  connection_status text not null check (
    connection_status in ('pairing', 'online', 'offline', 'revoked')
  ),
  battery_percent integer check (battery_percent between 0 and 100),
  is_charging boolean,
  network_type text not null default 'unknown' check (
    network_type in ('wifi', 'cellular', 'ethernet', 'offline', 'unknown')
  ),
  capabilities text[] not null default '{}',
  last_check_in_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, household_id)
);

create unique index seller_devices_one_primary_online
  on public.seller_devices (household_id)
  where is_primary and revoked_at is null;

create table public.seller_device_credentials (
  device_id uuid primary key references public.seller_devices(id) on delete cascade,
  token_hash char(64) not null check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

comment on table public.seller_device_credentials is
  'Server-only hashes for revocable Seller Hub bearer credentials. Plaintext tokens are returned once and never persisted.';

create table public.device_pairing_challenges (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  challenge_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  seller_device_id uuid references public.seller_devices(id) on delete cascade,
  platform text not null,
  app_version text not null,
  display_alias text not null,
  connection_status text not null check (
    connection_status in ('not_connected', 'connected', 'needs_login', 'unsupported_version', 'disabled')
  ),
  last_verified_at timestamptz,
  supported_capabilities text[] not null default '{}',
  policy_status text not null check (
    policy_status in ('approved', 'review', 'internal_only', 'disabled')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, platform)
);

comment on table public.platform_connections is
  'Connection health only. Marketplace passwords, cookies, refresh tokens, and session databases are prohibited.';

create table public.items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  category text not null,
  brand text,
  model text,
  condition text not null check (
    condition in ('new', 'like_new', 'good', 'fair', 'poor', 'for_parts', 'unknown')
  ),
  dimensions jsonb not null default '{}'::jsonb,
  specifications jsonb not null default '{}'::jsonb,
  accessories text[] not null default '{}',
  defects text[] not null default '{}',
  storage_location text,
  identification jsonb not null,
  identification_confidence numeric(4,3) not null check (
    identification_confidence between 0 and 1
  ),
  clearing_recommendation text not null check (
    clearing_recommendation in ('sell', 'bundle', 'give_away', 'donate', 'recycle', 'discard')
  ),
  status text not null check (
    status in (
      'captured', 'draft', 'ready', 'publishing', 'partially_live', 'live',
      'reserved', 'sold', 'given_away', 'donated', 'recycled', 'discarded', 'archived'
    )
  ),
  image_fingerprint text,
  barcode text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index items_household_status on public.items (household_id, status, updated_at desc);
create index items_duplicate_barcode on public.items (household_id, barcode) where barcode is not null;
create index items_duplicate_fingerprint on public.items (household_id, image_fingerprint)
  where image_fingerprint is not null;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  storage_path text not null,
  content_sha256 char(64) not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  media_type text not null check (media_type in ('image/jpeg', 'image/png', 'image/webp')),
  display_order smallint not null check (display_order between 0 and 11),
  is_lead boolean not null default false,
  quality_issues text[] not null default '{}',
  redaction_state text not null check (
    redaction_state in (
      'pending_scan', 'not_needed', 'suggested', 'reviewed_not_needed', 'approved', 'applied'
    )
  ),
  source text not null check (source in ('camera', 'library', 'import')),
  exif_location_stripped boolean not null default false,
  retention_state text not null check (
    retention_state in ('permanent', 'temporary', 'deletion_scheduled', 'deleted')
  ),
  delete_after timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, storage_path),
  unique (item_id, display_order)
);

create unique index media_assets_one_lead on public.media_assets (item_id) where is_lead;

create table public.item_enrichments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  input_fingerprint char(64) not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  media_fingerprint char(64) not null check (media_fingerprint ~ '^[a-f0-9]{64}$'),
  provider text not null,
  model text not null,
  output jsonb not null,
  created_at timestamptz not null default now(),
  unique (item_id, input_fingerprint, provider, model)
);

comment on table public.item_enrichments is
  'Unapproved AI suggestions with evidence and confidence. Canonical listing facts require a separate user approval step.';

create table public.canonical_listings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  version integer not null check (version >= 1),
  title text not null,
  description text not null,
  condition_summary text not null,
  specifications jsonb not null default '{}'::jsonb,
  price_strategy text not null check (price_strategy in ('sell_fast', 'balanced', 'maximize_value')),
  asking_price_cents integer not null check (asking_price_cents >= 0),
  minimum_price_cents integer not null check (
    minimum_price_cents >= 0 and minimum_price_cents <= asking_price_cents
  ),
  currency char(3) not null default 'USD',
  approximate_location jsonb not null,
  exchange_options text[] not null,
  payment_wording text not null,
  negotiation_rules jsonb not null,
  listing_provenance jsonb not null default '{}'::jsonb,
  restricted_item_status text not null check (restricted_item_status in ('clear', 'review', 'blocked')),
  restricted_item_reasons text[] not null default '{}',
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (item_id, version)
);

create table public.connector_definitions (
  id text primary key,
  platform text not null unique,
  kind text not null check (kind in ('api', 'android', 'browser', 'import')),
  version text not null,
  definition_version integer not null check (definition_version >= 1),
  enabled boolean not null default false,
  kill_switch_reason text,
  policy_status text not null check (
    policy_status in ('approved', 'review', 'internal_only', 'disabled')
  ),
  production_method text,
  approval_evidence_url text,
  policy_reviewed_at timestamptz,
  owner text not null,
  capabilities jsonb not null,
  supported_app_versions text[] not null default '{}',
  required_fields text[] not null default '{}',
  category_mappings jsonb not null default '{}'::jsonb,
  field_mappings jsonb not null default '{}'::jsonb,
  title_max_length integer not null default 100 check (title_max_length between 20 and 500),
  description_max_length integer not null default 5000 check (description_max_length between 100 and 10000),
  rate_limit_per_minute integer not null check (rate_limit_per_minute > 0),
  daily_listing_cap integer not null check (daily_listing_cap > 0),
  canary_test_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.connector_changes (
  id bigint generated always as identity primary key,
  connector_id text not null references public.connector_definitions(id) on delete cascade,
  version text not null,
  changed_by text not null,
  summary text not null,
  changed_at timestamptz not null default now(),
  unique (connector_id, version)
);

create table public.platform_listings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  platform text not null,
  external_listing_id text,
  external_url text,
  platform_title text not null,
  platform_price_cents integer not null check (platform_price_cents >= 0),
  currency char(3) not null default 'USD',
  status text not null check (
    status in ('not_published', 'publishing', 'live', 'reserved', 'sold', 'delisted', 'needs_action', 'failed')
  ),
  published_at timestamptz,
  last_synchronized_at timestamptz,
  connector_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_listing_variants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  listing_version integer not null check (listing_version >= 1),
  connector_id text not null references public.connector_definitions(id),
  connector_version text not null,
  platform text not null,
  title text not null,
  description text not null,
  category text not null,
  price_cents integer not null check (price_cents >= 0),
  currency char(3) not null default 'USD',
  fields jsonb not null,
  generated_at timestamptz not null default now(),
  unique (item_id, listing_version, platform)
);

create unique index platform_listings_one_active
  on public.platform_listings (item_id, platform)
  where status in ('publishing', 'live', 'reserved');

create table public.publishing_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  platform text not null,
  listing_version integer not null check (listing_version >= 1),
  idempotency_key text not null unique,
  current_state text not null,
  last_verified_state text not null,
  resume_state text,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries between 0 and 10),
  next_retry_at timestamptz,
  device_id uuid references public.seller_devices(id) on delete set null,
  connector_version text not null,
  platform_app_version text,
  command_action text not null check (
    command_action in ('publish', 'update_fields', 'mark_sold', 'delist', 'check_connection', 'pause', 'resume')
  ),
  command_payload jsonb not null default '{}'::jsonb,
  command_signature text,
  command_key_id text,
  command_expires_at timestamptz not null,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create index publishing_jobs_device_queue
  on public.publishing_jobs (device_id, current_state, created_at)
  where completed_at is null;

create table public.publishing_job_transitions (
  id bigint generated always as identity primary key,
  publishing_job_id uuid not null references public.publishing_jobs(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  from_state text not null,
  to_state text not null,
  event text not null,
  reason_code text,
  occurred_at timestamptz not null default now()
);

create table public.listing_export_artifacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  publishing_job_id uuid not null unique references public.publishing_jobs(id) on delete cascade,
  platform text not null,
  format text not null check (format in ('json')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table public.device_command_nonces (
  device_id uuid not null references public.seller_devices(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  primary key (device_id, nonce)
);

create table public.issued_device_commands (
  id bigint generated always as identity primary key,
  device_id uuid not null references public.seller_devices(id) on delete cascade,
  job_id uuid not null references public.publishing_jobs(id) on delete cascade,
  command_nonce text not null,
  expires_at timestamptz not null,
  signed_command jsonb not null,
  issued_at timestamptz not null default now(),
  unique (device_id, command_nonce)
);

create index issued_device_commands_active
  on public.issued_device_commands (device_id, job_id, expires_at desc);

create table public.buyer_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  platform_listing_id uuid not null references public.platform_listings(id) on delete cascade,
  participant_alias text not null,
  intent text not null,
  redacted_message_excerpt text not null default '',
  suggested_response text not null,
  approval_state text not null check (approval_state in ('pending', 'approved', 'rejected', 'sent')),
  price_offer_cents integer check (price_offer_cents >= 0),
  currency char(3),
  scheduling_state text not null default 'none' check (
    scheduling_state in ('none', 'proposed', 'confirmed', 'cancelled')
  ),
  requires_address_approval boolean not null default false,
  scam_signals text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expo_push_token text not null unique check (
    expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$'
  ),
  platform text not null check (platform in ('android', 'ios')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in (
    'publishing_paused', 'publishing_failed', 'publishing_published',
    'device_attention', 'buyer_task', 'inventory_exception'
  )),
  title text not null,
  body text not null,
  action_path text,
  delivery_state text not null check (
    delivery_state in ('queued', 'sent', 'failed', 'no_subscription')
  ),
  delivery_attempts integer not null default 0 check (delivery_attempts between 0 and 10),
  next_delivery_at timestamptz not null default now(),
  provider_ticket_ids text[] not null default '{}',
  read_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index user_notifications_delivery_queue
  on public.user_notifications (delivery_state, next_delivery_at)
  where delivery_state = 'queued';

create table public.meetups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  platform_listing_id uuid not null references public.platform_listings(id) on delete cascade,
  buyer_alias text not null,
  scheduled_at timestamptz not null,
  location_type text not null check (
    location_type in ('public_meetup', 'porch_pickup', 'buyer_pickup', 'local_delivery')
  ),
  approved_location text not null,
  exact_address_approved_at timestamptz,
  status text not null check (status in ('proposed', 'confirmed', 'completed', 'cancelled', 'no_show')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.buyer_backup_queue (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  platform_listing_id uuid not null references public.platform_listings(id) on delete cascade,
  buyer_task_id uuid not null references public.buyer_tasks(id) on delete cascade,
  participant_alias text not null,
  position integer not null check (position > 0),
  status text not null check (status in ('waiting', 'promoted', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, buyer_task_id)
);

create unique index buyer_backup_queue_active_position
  on public.buyer_backup_queue (item_id, position)
  where status = 'waiting';

create table public.item_outcomes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid not null references public.items(id) on delete cascade,
  outcome text not null check (outcome in ('sold', 'given_away', 'donated', 'recycled', 'discarded')),
  sale_price_cents integer check (sale_price_cents >= 0),
  currency char(3),
  destination_platform text,
  days_to_clear numeric(10,2) not null check (days_to_clear >= 0),
  notes text,
  cleared_at timestamptz not null default now(),
  unique (item_id)
);

create table public.exception_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  item_id uuid references public.items(id) on delete cascade,
  kind text not null,
  title text not null,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references public.households(id) on delete cascade,
  actor_id text not null,
  actor_type text not null check (actor_type in ('user', 'device', 'service', 'admin')),
  action text not null,
  object_type text not null,
  object_id text not null,
  device_id uuid references public.seller_devices(id) on delete set null,
  redacted_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  subject_hash char(64) not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('requested', 'revoking', 'deleting', 'complete', 'failed')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  failure_reason text
);

create unique index one_active_account_deletion_request
  on public.account_deletion_requests (user_id)
  where user_id is not null and status <> 'failed';

create table public.account_deletion_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.account_deletion_requests(id),
  subject_hash char(64) not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  completed_at timestamptz not null
);

create table public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,79}$'),
  description text not null,
  enabled boolean not null,
  kill_switch_reason text,
  owner text not null,
  version integer not null check (version > 0),
  updated_at timestamptz not null default now(),
  check (enabled = (kill_switch_reason is null))
);

create table public.feature_flag_changes (
  flag_key text not null references public.feature_flags(key) on delete cascade,
  version integer not null check (version > 0),
  changed_at timestamptz not null,
  changed_by text not null,
  summary text not null,
  primary key (flag_key, version)
);

create table public.production_releases (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (version ~ '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'),
  target text not null check (target in ('public_beta', 'v1_public')),
  summary text not null,
  connector_ids text[] not null,
  evidence jsonb not null default '[]'::jsonb,
  status text not null check (
    status in ('draft', 'pending_approval', 'approved', 'deployed', 'rejected', 'rolled_back')
  ),
  created_by text not null,
  approval_actor_ids text[] not null default '{}',
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  deployed_at timestamptz,
  check (cardinality(connector_ids) between 2 and 100),
  check (cardinality(approval_actor_ids) <= 2),
  check (not (created_by = any(approval_actor_ids))),
  check (
    status not in ('approved', 'deployed', 'rolled_back') or
    (cardinality(approval_actor_ids) = 2 and approved_at is not null)
  ),
  check (status <> 'deployed' or deployed_at is not null),
  check (status <> 'rejected' or rejection_reason is not null)
);

create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  granted_by uuid not null references public.profiles(id) on delete cascade,
  support_actor_id text not null,
  reason_code text not null,
  scope text[] not null,
  diagnostic_consent boolean not null default false,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (cardinality(scope) between 1 and 3),
  check (scope <@ array['job_metadata', 'device_health', 'diagnostic_artifacts']),
  check (not ('diagnostic_artifacts' = any(scope)) or diagnostic_consent),
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);

create table public.diagnostic_artifacts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  grant_id uuid not null references public.support_access_grants(id) on delete cascade,
  submitted_by uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('publishing_screen', 'device_health', 'error_context')),
  storage_path text not null,
  content_sha256 char(64) not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  redacted boolean not null check (redacted),
  privacy_scan_passed boolean not null check (privacy_scan_passed),
  consented_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Tenant-scoped relationships are enforced twice: by the ordinary foreign
-- key and by a composite key that prevents a service bug from associating a
-- child row with an object in another household.
alter table public.items add constraint items_id_household_unique
  unique (id, household_id);
alter table public.platform_listings add constraint platform_listings_id_household_unique
  unique (id, household_id);
alter table public.publishing_jobs add constraint publishing_jobs_id_household_unique
  unique (id, household_id);
alter table public.publishing_jobs add constraint publishing_jobs_id_device_unique
  unique (id, device_id);
alter table public.buyer_tasks add constraint buyer_tasks_id_household_unique
  unique (id, household_id);
alter table public.support_access_grants add constraint support_grants_id_household_unique
  unique (id, household_id);

alter table public.platform_connections add constraint platform_connections_device_household_fk
  foreign key (seller_device_id, household_id)
  references public.seller_devices (id, household_id);
alter table public.media_assets add constraint media_assets_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.item_enrichments add constraint item_enrichments_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.canonical_listings add constraint canonical_listings_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.platform_listings add constraint platform_listings_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.platform_listing_variants add constraint platform_variants_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.publishing_jobs add constraint publishing_jobs_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.publishing_jobs add constraint publishing_jobs_device_household_fk
  foreign key (device_id, household_id)
  references public.seller_devices (id, household_id);
alter table public.publishing_job_transitions add constraint job_transitions_job_household_fk
  foreign key (publishing_job_id, household_id)
  references public.publishing_jobs (id, household_id);
alter table public.listing_export_artifacts add constraint listing_exports_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.listing_export_artifacts add constraint listing_exports_job_household_fk
  foreign key (publishing_job_id, household_id)
  references public.publishing_jobs (id, household_id);
alter table public.issued_device_commands add constraint issued_commands_job_device_fk
  foreign key (job_id, device_id) references public.publishing_jobs (id, device_id);
alter table public.buyer_tasks add constraint buyer_tasks_listing_household_fk
  foreign key (platform_listing_id, household_id)
  references public.platform_listings (id, household_id);
alter table public.meetups add constraint meetups_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.meetups add constraint meetups_listing_household_fk
  foreign key (platform_listing_id, household_id)
  references public.platform_listings (id, household_id);
alter table public.buyer_backup_queue add constraint backup_queue_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.buyer_backup_queue add constraint backup_queue_listing_household_fk
  foreign key (platform_listing_id, household_id)
  references public.platform_listings (id, household_id);
alter table public.buyer_backup_queue add constraint backup_queue_task_household_fk
  foreign key (buyer_task_id, household_id)
  references public.buyer_tasks (id, household_id);
alter table public.item_outcomes add constraint outcomes_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.exception_tasks add constraint exception_tasks_item_household_fk
  foreign key (item_id, household_id) references public.items (id, household_id);
alter table public.audit_events add constraint audit_events_device_household_fk
  foreign key (device_id, household_id)
  references public.seller_devices (id, household_id);
alter table public.diagnostic_artifacts add constraint diagnostics_grant_household_fk
  foreign key (grant_id, household_id)
  references public.support_access_grants (id, household_id);

create or replace function public.prevent_record_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable record cannot be updated';
end;
$$;

create trigger canonical_listings_immutable before update on public.canonical_listings
for each row execute function public.prevent_record_update();
create trigger connector_changes_immutable before update on public.connector_changes
for each row execute function public.prevent_record_update();
create trigger publishing_job_transitions_immutable before update on public.publishing_job_transitions
for each row execute function public.prevent_record_update();
create trigger audit_events_immutable before update on public.audit_events
for each row execute function public.prevent_record_update();
create trigger feature_flag_changes_immutable before update on public.feature_flag_changes
for each row execute function public.prevent_record_update();

create trigger profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger households_updated_at before update on public.households
for each row execute function public.set_updated_at();
create trigger seller_devices_updated_at before update on public.seller_devices
for each row execute function public.set_updated_at();
create trigger platform_connections_updated_at before update on public.platform_connections
for each row execute function public.set_updated_at();
create trigger items_updated_at before update on public.items
for each row execute function public.set_updated_at();
create trigger connector_definitions_updated_at before update on public.connector_definitions
for each row execute function public.set_updated_at();
create trigger platform_listings_updated_at before update on public.platform_listings
for each row execute function public.set_updated_at();
create trigger publishing_jobs_updated_at before update on public.publishing_jobs
for each row execute function public.set_updated_at();
create trigger buyer_tasks_updated_at before update on public.buyer_tasks
for each row execute function public.set_updated_at();
create trigger push_subscriptions_updated_at before update on public.push_subscriptions
for each row execute function public.set_updated_at();
create trigger meetups_updated_at before update on public.meetups
for each row execute function public.set_updated_at();
create trigger buyer_backup_queue_updated_at before update on public.buyer_backup_queue
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.seller_devices enable row level security;
alter table public.seller_device_credentials enable row level security;
alter table public.device_pairing_challenges enable row level security;
alter table public.platform_connections enable row level security;
alter table public.items enable row level security;
alter table public.media_assets enable row level security;
alter table public.canonical_listings enable row level security;
alter table public.item_enrichments enable row level security;
alter table public.platform_listings enable row level security;
alter table public.platform_listing_variants enable row level security;
alter table public.publishing_jobs enable row level security;
alter table public.publishing_job_transitions enable row level security;
alter table public.listing_export_artifacts enable row level security;
alter table public.device_command_nonces enable row level security;
alter table public.issued_device_commands enable row level security;
alter table public.buyer_tasks enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.user_notifications enable row level security;
alter table public.meetups enable row level security;
alter table public.buyer_backup_queue enable row level security;
alter table public.item_outcomes enable row level security;
alter table public.exception_tasks enable row level security;
alter table public.audit_events enable row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.account_deletion_receipts enable row level security;
alter table public.feature_flags enable row level security;
alter table public.feature_flag_changes enable row level security;
alter table public.production_releases enable row level security;
alter table public.support_access_grants enable row level security;
alter table public.diagnostic_artifacts enable row level security;

create policy profiles_self_read on public.profiles
  for select to authenticated using (id = auth.uid());
create policy profiles_self_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy households_members_read on public.households
  for select to authenticated using (public.is_household_member(id));

create policy household_members_read on public.household_members
  for select to authenticated using (public.is_household_member(household_id));

create policy seller_devices_household_read on public.seller_devices
  for select to authenticated using (public.is_household_member(household_id));
create policy pairing_challenges_household_read on public.device_pairing_challenges
  for select to authenticated using (public.is_household_member(household_id));
create policy platform_connections_household_read on public.platform_connections
  for select to authenticated using (public.is_household_member(household_id));
create policy items_household_read on public.items
  for select to authenticated using (public.is_household_member(household_id));
create policy media_assets_household_read on public.media_assets
  for select to authenticated using (public.is_household_member(household_id));
create policy item_enrichments_household_read on public.item_enrichments
  for select to authenticated using (public.is_household_member(household_id));
create policy canonical_listings_household_read on public.canonical_listings
  for select to authenticated using (public.is_household_member(household_id));
create policy platform_listings_household_read on public.platform_listings
  for select to authenticated using (public.is_household_member(household_id));
create policy platform_listing_variants_household_read on public.platform_listing_variants
  for select to authenticated using (public.is_household_member(household_id));
create policy publishing_jobs_household_read on public.publishing_jobs
  for select to authenticated using (public.is_household_member(household_id));
create policy job_transitions_household_read on public.publishing_job_transitions
  for select to authenticated using (public.is_household_member(household_id));
create policy listing_export_artifacts_household_read on public.listing_export_artifacts
  for select to authenticated using (public.is_household_member(household_id));
create policy buyer_tasks_household_read on public.buyer_tasks
  for select to authenticated using (public.is_household_member(household_id));
create policy push_subscriptions_self_read on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy user_notifications_self on public.user_notifications
  for select to authenticated using (
    user_id = auth.uid() and public.is_household_member(household_id)
  );
create policy meetups_household_read on public.meetups
  for select to authenticated using (public.is_household_member(household_id));
create policy buyer_backup_queue_household_read on public.buyer_backup_queue
  for select to authenticated using (public.is_household_member(household_id));
create policy outcomes_household_read on public.item_outcomes
  for select to authenticated using (public.is_household_member(household_id));
create policy exception_tasks_household_read on public.exception_tasks
  for select to authenticated using (public.is_household_member(household_id));
create policy audit_events_household_read on public.audit_events
  for select to authenticated using (
    household_id is not null and public.is_household_member(household_id)
  );
create policy deletion_requests_self on public.account_deletion_requests
  for select to authenticated using (user_id = auth.uid());
create policy support_grants_household_read on public.support_access_grants
  for select to authenticated using (public.is_household_member(household_id));
create policy diagnostic_artifacts_household_read on public.diagnostic_artifacts
  for select to authenticated using (public.is_household_member(household_id));

alter table public.connector_definitions enable row level security;
alter table public.connector_changes enable row level security;
create policy connectors_authenticated_read on public.connector_definitions
  for select to authenticated using (true);
create policy connector_changes_authenticated_read on public.connector_changes
  for select to authenticated using (true);
create policy feature_flags_authenticated_read on public.feature_flags
  for select to authenticated using (true);
create policy feature_flag_changes_authenticated_read on public.feature_flag_changes
  for select to authenticated using (true);

alter publication supabase_realtime add table public.seller_devices;
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.platform_listings;
alter publication supabase_realtime add table public.publishing_jobs;
alter publication supabase_realtime add table public.buyer_tasks;
alter publication supabase_realtime add table public.meetups;
alter publication supabase_realtime add table public.buyer_backup_queue;
alter publication supabase_realtime add table public.user_notifications;
alter publication supabase_realtime add table public.feature_flags;
alter publication supabase_realtime add table public.support_access_grants;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'item-media',
  'item-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

create policy item_media_household_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'item-media'
    and public.is_household_member(((storage.foldername(name))[1])::uuid)
  );
create policy item_media_household_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'item-media'
    and public.is_household_member(((storage.foldername(name))[1])::uuid)
  );
create policy item_media_household_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'item-media'
    and public.is_household_member(((storage.foldername(name))[1])::uuid)
    and not exists (
      select 1 from public.media_assets
      where media_assets.storage_path = storage.objects.name
    )
  );
