import { NextResponse } from "next/server";

import { loadAuthContext } from "@/lib/auth-context";
import { loadCapabilities } from "@/lib/authorization";
import { createClient } from "@/lib/supabase/server";

function csv(value: unknown) { const raw = String(value ?? ""); const safe = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; }

export async function GET(request: Request) {
  const supabase = await createClient(); const context = await loadAuthContext(supabase); if (!context?.activeOrganization) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const capabilities = await loadCapabilities(supabase); if (!capabilities["customer.read"] && !capabilities["task.manage"] && !capabilities["reports.view"]) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const url = new URL(request.url); const status = url.searchParams.get("status"); const severity = url.searchParams.get("severity");
  let query = supabase.from("complaints").select("reference_code,branch_id,customer_id,booking_id,pet_id,assigned_resource_id,category,severity,status,title,description,resolution_notes,recovery_action,reported_at,resolved_at,closed_at").eq("organization_id", context.activeOrganization.id).is("deleted_at", null).order("reported_at", { ascending: false }).limit(5000);
  if (["open", "investigating", "resolved", "closed"].includes(status ?? "")) query = query.eq("status", status!); if (["low", "medium", "high", "critical"].includes(severity ?? "")) query = query.eq("severity", severity!);
  const result = await query; if (result.error) { console.error("complaint export failed", { code: result.error.code, message: result.error.message }); return NextResponse.json({ error: "export_failed" }, { status: 500 }); }
  const rows = result.data ?? []; const branchIds = [...new Set(rows.map((row) => row.branch_id))]; const customerIds = [...new Set(rows.map((row) => row.customer_id))]; const petIds = [...new Set(rows.map((row) => row.pet_id).filter((id): id is string => Boolean(id)))]; const resourceIds = [...new Set(rows.map((row) => row.assigned_resource_id).filter((id): id is string => Boolean(id)))];
  const [branches, customers, pets, resources] = await Promise.all([branchIds.length ? supabase.from("branches").select("id,name").eq("organization_id", context.activeOrganization.id).in("id", branchIds) : Promise.resolve({ data: [] }), customerIds.length ? supabase.from("customers").select("id,display_name").eq("organization_id", context.activeOrganization.id).in("id", customerIds) : Promise.resolve({ data: [] }), petIds.length ? supabase.from("pets").select("id,name").eq("organization_id", context.activeOrganization.id).in("id", petIds) : Promise.resolve({ data: [] }), resourceIds.length ? supabase.from("resources").select("id,name").eq("organization_id", context.activeOrganization.id).in("id", resourceIds) : Promise.resolve({ data: [] })]);
  const branchNames = new Map((branches.data ?? []).map((row) => [row.id, row.name])); const customerNames = new Map((customers.data ?? []).map((row) => [row.id, row.display_name])); const petNames = new Map((pets.data ?? []).map((row) => [row.id, row.name])); const resourceNames = new Map((resources.data ?? []).map((row) => [row.id, row.name]));
  const header = ["reference_code","branch","customer","booking_id","pet","groomer","category","severity","status","title","description","resolution_notes","recovery_action","reported_at","resolved_at","closed_at"];
  const lines = [header.map(csv).join(","), ...rows.map((row) => [row.reference_code,branchNames.get(row.branch_id) ?? row.branch_id,customerNames.get(row.customer_id) ?? row.customer_id,row.booking_id,row.pet_id ? petNames.get(row.pet_id) ?? row.pet_id : "",row.assigned_resource_id ? resourceNames.get(row.assigned_resource_id) ?? row.assigned_resource_id : "",row.category,row.severity,row.status,row.title,row.description,row.resolution_notes,row.recovery_action,row.reported_at,row.resolved_at,row.closed_at].map(csv).join(","))];
  return new NextResponse(`\uFEFF${lines.join("\r\n")}`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="operro-complaints-${new Date().toISOString().slice(0,10)}.csv"`, "cache-control": "no-store" } });
}
