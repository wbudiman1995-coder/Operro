import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const sql=fs.readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20260918160000_customer_self_onboarding.sql"),"utf8");
const uploadSql=fs.readFileSync(path.resolve(process.cwd(),"../../supabase/migrations/20260918180000_onboarding_styling_uploads.sql"),"utf8");
test("onboarding stores only a token hash and grants no anonymous table access",()=>{assert.match(sql,/token_hash text not null unique/);assert.match(sql,/digest\(p_token,'sha256'\)/);assert.doesNotMatch(sql,/grant[^;]+customer_onboarding_(links|submissions)[^;]+\bto anon\b/i)});
test("public RPCs are narrow while review stays authenticated",()=>{assert.match(sql,/grant execute on function app\.get_customer_onboarding_link\(text\) to anon,authenticated/);assert.match(sql,/grant execute on function app\.submit_customer_onboarding\(text,jsonb\) to anon,authenticated/);assert.match(sql,/grant execute on function app\.review_customer_onboarding\(uuid,text,uuid\) to authenticated/);assert.doesNotMatch(sql,/review_customer_onboarding\(uuid,text,uuid\) to anon/)});
test("one link can create only one pending submission and is consumed",()=>{assert.match(sql,/uq_onboarding_submission_link unique \(link_id\)/);assert.match(sql,/where token_hash=[\s\S]*for update/);assert.match(sql,/set status='submitted'/)});
test("approval is tenant and permission scoped and rejection never creates CRM rows",()=>{assert.match(sql,/v_org is null or not app\.has_permission\('customer\.manage'\)/);assert.match(sql,/organization_id=v_org and id=p_submission/);const reject=sql.slice(sql.indexOf("if p_decision='reject'"),sql.indexOf("v_payload:=v_sub.payload"));assert.doesNotMatch(reject,/insert into public\.(customers|pets|customer_addresses)/)});
test("onboarding styling uploads are token scoped and never expose raw tokens in paths",()=>{assert.match(uploadSql,/can_upload_onboarding_style\(\(storage\.foldername\(name\)\)\[1\],\(storage\.foldername\(name\)\)\[2\]\)/);assert.match(uploadSql,/l\.token_hash=p_hash/);assert.doesNotMatch(uploadSql,/for select to anon/)});
test("approval validates uploaded object ownership before linking it to the created pet",()=>{assert.match(uploadSql,/v_path like v_org::text\|\|'.'\|\|v_link\.token_hash/);assert.match(uploadSql,/exists\(select 1 from storage\.objects where bucket_id='onboarding-styling' and name=v_path\)/);assert.match(uploadSql,/insert into public\.attachment_links/)});
