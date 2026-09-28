// Local-only PostgREST authorization checks; run after membership_closeout_browser_seed.sql.
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
assert.match(url ?? '', /^http:\/\/(127\.0\.0\.1|localhost):54361$/);
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
async function login(email) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: 'operro-local-qa' });
  assert.equal(error, null);
  return client;
}
const owner = await login('wbudiman1995@gmail.com');
const reader = await login('membership-reader@homepaw.local');
const groomer = await login('groomer@homepaw.local');
const { data: cp, error } = await owner.from('customer_packages').select('*').eq('package_id','e1c00001-0000-4000-8000-000000000001').single();
assert.equal(error, null);
const correction = { p_customer_package: cp.id, p_revision: cp.revision, p_reason: 'QA HTTP guard', p_expires_at: cp.expires_at, p_pet: cp.pet_id, p_service: cp.service_id };
for (const [name, result, code] of [
  ['reader correction denied', await reader.schema('app').rpc('update_customer_package_terms', correction), '42501'],
  ['reader repair denied', await reader.schema('app').rpc('repair_customer_package_balance', {p_customer_package:cp.id,p_revision:cp.revision,p_request_key:crypto.randomUUID()}), '42501'],
  ['owner null revision denied', await owner.schema('app').rpc('update_customer_package_terms', {...correction,p_revision:null}), '40001'],
  ['locked scope tampering denied', await owner.schema('app').rpc('update_customer_package_terms', {...correction,p_pet:null,p_service:null}), '23514'],
]) {
  assert.equal(result.error?.code, code, `${name}: ${result.error?.message}`);
  console.log(`PASS: ${name} (${code})`);
}
const read = await reader.from('customer_packages').select('id').eq('id',cp.id);
assert.equal(read.error,null); assert.equal(read.data.length,1);
console.log('PASS: authenticated reader can view membership');
const denied = await groomer.from('customer_packages').select('id');
assert.equal(denied.error,null); assert.equal(denied.data.length,0);
console.log('PASS: no-access groomer sees zero membership rows through RLS');
const after = await owner.from('customer_packages').select('*').eq('id',cp.id).single();
assert.equal(after.error,null); assert.deepEqual(after.data,cp);
console.log('PASS: all rejected HTTP writes preserve the complete membership row');
for (const client of [owner,reader,groomer]) await client.auth.signOut({ scope: 'local' });
