-- Structured addresses + service-area coverage for HomePaw Demo, on top of
-- homepaw_demo.sql. Kept separate so the original seed file's own tested
-- shape is untouched. Idempotent: re-running `supabase db reset` is safe.
do $$
declare
  v_org uuid := 'd0000000-0000-4000-8000-000000000001';
  v_branch uuid := 'd0000000-0000-4000-8000-000000000010';
begin
  insert into public.customer_addresses (
    id, organization_id, customer_id, label, recipient_name, recipient_phone,
    line1, rt, rw, kelurahan, kecamatan, kabupaten_kota, province, postal_code,
    landmark, access_notes, latitude, longitude, is_default
  ) values
  ('d0000000-0000-4000-8000-000000000921', v_org, 'd0000000-0000-4000-8000-000000000301',
   'Rumah', 'Cynthia Tan', '0812-3456-7890',
   'Jl. Boulevard Barat Raya No. 12', '004', '003', 'Kelapa Gading Barat', 'Kelapa Gading',
   'Jakarta Utara', 'DKI Jakarta', '14240',
   'Sebelah minimarket Alfamart, pagar hitam', 'Pagar hijau, bel di sisi kanan, titipkan ke satpam bila tidak ada orang',
   -6.159200, 106.909300, true),
  ('d0000000-0000-4000-8000-000000000922', v_org, 'd0000000-0000-4000-8000-000000000302',
   'Rumah', 'Rico Wijaya', '0813-2211-4477',
   'Jl. Danau Sunter Utara Blok C2 No. 8', '002', '005', 'Sunter Agung', 'Sunter',
   'Jakarta Utara', 'DKI Jakarta', '14350',
   'Dekat lapangan basket komplek', 'Komplek berpagar, sebut nomor unit ke security depan',
   -6.146700, 106.868300, true),
  ('d0000000-0000-4000-8000-000000000923', v_org, 'd0000000-0000-4000-8000-000000000305',
   'Kantor', 'Nadia Sari', '0857-7789-1123',
   'Jl. Percetakan Negara No. 45', null, null, 'Cempaka Putih Timur', 'Cempaka Putih',
   'Jakarta Pusat', 'DKI Jakarta', '10510',
   'Ruko 3 lantai, warna krem', 'Parkir motor di depan, lantai 2',
   -6.179400, 106.869900, true),
  ('d0000000-0000-4000-8000-000000000924', v_org, 'd0000000-0000-4000-8000-000000000304',
   'Rumah', 'Jonathan Lim', '0811-9900-2244',
   'Jl. Boulevard Raya Blok QJ No. 3', '007', '002', 'Kelapa Gading Timur', 'Kelapa Gading',
   'Jakarta Utara', 'DKI Jakarta', '14240',
   'Seberang taman lingkungan', 'Rumah pagar putih, anjing besar di rumah tetangga sebelah kiri',
   -6.157800, 106.913400, true)
  on conflict (id) do update set
    line1 = excluded.line1, kecamatan = excluded.kecamatan, kabupaten_kota = excluded.kabupaten_kota,
    latitude = excluded.latitude, longitude = excluded.longitude;

  insert into public.branch_service_areas (
    id, organization_id, branch_id, kecamatan, kabupaten_kota, travel_fee, estimated_travel_minutes, is_active
  ) values
  ('d0000000-0000-4000-8000-000000000931', v_org, v_branch, 'Kelapa Gading', 'Jakarta Utara', 25000, 20, true),
  ('d0000000-0000-4000-8000-000000000932', v_org, v_branch, 'Sunter', 'Jakarta Utara', 35000, 30, true),
  ('d0000000-0000-4000-8000-000000000933', v_org, v_branch, null, 'Jakarta Pusat', 50000, 45, true)
  on conflict (id) do update set
    travel_fee = excluded.travel_fee, estimated_travel_minutes = excluded.estimated_travel_minutes;

  -- Give the existing home-service demo bookings (from homepaw_demo.sql) a
  -- real snapshot, as if they had been created through the new booking flow.
  update public.bookings b set
    customer_address_id = ca.id,
    address_snapshot = jsonb_build_object(
      'label', ca.label, 'recipient_name', ca.recipient_name, 'recipient_phone', ca.recipient_phone,
      'line1', ca.line1, 'rt', ca.rt, 'rw', ca.rw, 'kelurahan', ca.kelurahan, 'kecamatan', ca.kecamatan,
      'kabupaten_kota', ca.kabupaten_kota, 'province', ca.province, 'postal_code', ca.postal_code,
      'landmark', ca.landmark, 'access_notes', ca.access_notes, 'latitude', ca.latitude, 'longitude', ca.longitude
    ),
    travel_fee = coalesce(sa.travel_fee, 0),
    travel_minutes_snapshot = coalesce(sa.estimated_travel_minutes, 0),
    service_area_matched = true,
    dispatch_stage = case when b.status in ('completed','canceled','no_show') then null else 'scheduled' end
  from public.customer_addresses ca
  left join lateral (
    select * from public.branch_service_areas sa
    where sa.organization_id = ca.organization_id and sa.branch_id = v_branch
      and sa.kabupaten_kota = ca.kabupaten_kota and (sa.kecamatan is null or sa.kecamatan = ca.kecamatan)
    order by (sa.kecamatan is not null) desc
    limit 1
  ) sa on true
  where b.organization_id = v_org and b.customer_id = ca.customer_id and ca.is_default
    and b.fulfillment_mode = 'home' and b.metadata->>'demo_seed' = 'homepaw_v1';
end $$;

-- Note: Maya Putri and Kevin Halim deliberately keep only the old informal
-- address (address->>'area') and no customer_addresses row — neither has a
-- home-service booking (503 is in_store, 506 is pickup_delivery), and a real
-- tenant will always have a mix of fully-onboarded and not-yet-onboarded
-- customers; the UI must not break for the latter.
