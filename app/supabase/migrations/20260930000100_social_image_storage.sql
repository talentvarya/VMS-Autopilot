-- Phase G.8 - a public Storage bucket for AI-generated flyer/creative images.
--
-- Public read (so a generated image displays directly by URL, the same way any other public
-- marketing asset would) - but only the server's own service-role key ever uploads to it
-- (see app/src/lib/agents/social/image.ts). Nobody's own browser session can upload here
-- directly.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-images', 'social-images', true, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy "social-images are publicly readable"
  on storage.objects for select
  to public
  using (bucket_id = 'social-images');
