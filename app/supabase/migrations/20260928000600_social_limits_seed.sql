-- GENERATED FILE - DO NOT EDIT BY HAND.
-- Source of truth: src/lib/social/networks.ts
-- Regenerate with: npm run gen:social
-- A test fails if this file is out of date.

begin;

delete from public.social_network_limits;
insert into public.social_network_limits (network, max_chars) values
  ('instagram', 2200),
  ('facebook', 63206),
  ('x', 280),
  ('linkedin', 3000),
  ('google_business', 1500),
  ('youtube', 5000),
  ('tiktok', 2200);

commit;
