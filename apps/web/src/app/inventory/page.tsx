/** Inventory route for the HomePaw pilot. */
import { InventoryForm } from "@/components/pilot-forms";
import { PageHeader, StatCard } from "@/components/pilot-ui";
import { WorkspaceShell } from "@/components/workspace-shell";
import { loadCatalogWorkspace } from "@/lib/pilot-data";
import { requireActiveWorkspace } from "@/lib/require-workspace";

export const metadata = { title: "Inventaris" };

export default async function InventoryPage() {
  const workspace = await requireActiveWorkspace(); const data = await loadCatalogWorkspace(workspace.supabase, workspace.activeOrganization.id);
  const lowStock = data.products.filter((item) => item.stock <= 5).length;
  return <WorkspaceShell {...workspace} activePath="/inventory"><PageHeader eyebrow="Stok operasional" title="Inventaris" description="Saldo berasal dari ledger pergerakan; setiap penyesuaian tercatat dan tidak menimpa histori." />
    <div className="mt-7 grid gap-4 sm:grid-cols-2"><StatCard label="Produk" value={String(data.products.length)} helper="SKU aktif di katalog HomePaw." /><StatCard label="Stok rendah" value={String(lowStock)} helper="Produk dengan saldo lima unit atau kurang." tone={lowStock ? "warning" : "success"} /></div>
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"><h2 className="font-bold">Penyesuaian stok</h2><p className="mb-5 mt-1 text-xs text-slate-500">Gunakan angka positif untuk barang masuk dan negatif untuk pemakaian/koreksi.</p><InventoryForm branches={data.branches} products={data.products} /></section>
    <section className="mt-7 rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b p-5"><h2 className="font-bold">Saldo saat ini</h2></div><div className="divide-y">{data.products.map((product) => <div key={product.id} className="flex items-center justify-between p-5"><div><p className="font-bold">{product.name}</p><p className="mt-1 text-xs text-slate-500">{product.sku ?? "Tanpa SKU"}</p></div><p className={`text-xl font-bold ${product.stock <= 5 ? "text-amber-700" : "text-slate-900"}`}>{product.stock.toLocaleString("id-ID")}</p></div>)}</div></section>
  </WorkspaceShell>;
}
