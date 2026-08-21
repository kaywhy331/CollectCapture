\set ON_ERROR_STOP on

grant usage on schema public, storage to authenticated;
grant select, insert, update, delete on all tables in schema public, storage to authenticated;
grant usage, select on all sequences in schema public, storage to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000001', 'alice@example.test', '{"name":"Alice"}'),
  ('00000000-0000-0000-0000-000000000002', 'bob@example.test', '{"name":"Bob"}');

insert into public.households (
  id, owner_id, name, zip_code, selling_radius_miles,
  exchange_preferences, payment_wording
) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Alice home', '94107', 10, array['pickup'], 'cash_preferred'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Bob home', '94607', 10, array['pickup'], 'cash_preferred');

insert into public.household_members (household_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'owner'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'owner');

insert into public.items (
  id, household_id, title, category, condition, identification,
  identification_confidence, clearing_recommendation, status
) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Alice chair', 'Furniture', 'good', '{}', 0.9, 'sell', 'draft'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Bob chair', 'Furniture', 'good', '{}', 0.9, 'sell', 'draft');

insert into public.audit_events (
  id, household_id, actor_id, actor_type, action, object_type, object_id
) values (
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'service', 'service', 'created', 'item',
  '20000000-0000-0000-0000-000000000001'
);

do $$
begin
  begin
    insert into public.media_assets (
      household_id, item_id, storage_path, content_sha256, media_type,
      display_order, redaction_state, source, exif_location_stripped,
      retention_state
    ) values (
      '10000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002',
      'cross-tenant.jpg', repeat('a', 64), 'image/jpeg', 0,
      'not_needed', 'camera', true, 'permanent'
    );
    raise exception 'cross-household foreign key unexpectedly accepted';
  exception when foreign_key_violation then
    raise notice 'PASS composite tenant foreign key';
  end;

  begin
    update public.audit_events
    set action = 'rewritten'
    where id = '30000000-0000-0000-0000-000000000001';
    raise exception 'immutable audit event unexpectedly updated';
  exception when raise_exception then
    if sqlerrm = 'immutable record cannot be updated' then
      raise notice 'PASS immutable audit trigger';
    else
      raise;
    end if;
  end;
end;
$$;

set role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000001',
  false
);

do $$
declare
  visible_count integer;
  changed_count integer;
begin
  select count(*) into visible_count from public.items;
  if visible_count <> 1 then
    raise exception 'expected one household item, saw %', visible_count;
  end if;
  if exists (
    select 1 from public.items
    where id = '20000000-0000-0000-0000-000000000002'
  ) then
    raise exception 'cross-household item was visible';
  end if;
  raise notice 'PASS household read isolation';

  update public.items
  set title = 'forged'
  where id = '20000000-0000-0000-0000-000000000001';
  get diagnostics changed_count = row_count;
  if changed_count <> 0 then
    raise exception 'direct item update unexpectedly changed % rows', changed_count;
  end if;
  raise notice 'PASS API-governed update denied';

  begin
    insert into public.items (
      household_id, title, category, condition, identification,
      identification_confidence, clearing_recommendation, status
    ) values (
      '10000000-0000-0000-0000-000000000001', 'forged', 'Other', 'good', '{}',
      0.9, 'sell', 'draft'
    );
    raise exception 'direct item insert unexpectedly accepted';
  exception when insufficient_privilege then
    raise notice 'PASS API-governed insert denied';
  end;

  update public.profiles
  set name = 'Alice Updated'
  where id = '00000000-0000-0000-0000-000000000001';
  get diagnostics changed_count = row_count;
  if changed_count <> 1 then
    raise exception 'self profile update changed % rows', changed_count;
  end if;
  raise notice 'PASS self profile update';

  insert into storage.objects (bucket_id, name)
  values ('item-media', '10000000-0000-0000-0000-000000000001/item/photo.jpg');
  raise notice 'PASS household storage insert';

  begin
    insert into storage.objects (bucket_id, name)
    values ('item-media', '10000000-0000-0000-0000-000000000002/item/photo.jpg');
    raise exception 'cross-household storage insert unexpectedly accepted';
  exception when insufficient_privilege then
    raise notice 'PASS cross-household storage insert denied';
  end;
end;
$$;

reset role;
