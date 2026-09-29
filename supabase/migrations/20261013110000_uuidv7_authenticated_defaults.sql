-- Authenticated inserts may use app.fn_uuid_v7() as a column default.
-- pgcrypto lives in the extensions schema and app roles are not guaranteed
-- USAGE there. The generator only reads the clock and random bytes, so run
-- that fixed body with the migration owner's extension privileges instead
-- of granting broad access to every extension function.
alter function app.fn_uuid_v7() security definer;

comment on function app.fn_uuid_v7() is
  'RFC 9562 UUIDv7 primary-key generator. SECURITY DEFINER lets authenticated '
  'column defaults resolve pgcrypto in extensions without schema-wide grants.';
