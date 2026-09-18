import { PublicOnboardingForm } from "@/components/public-onboarding-form";
export const metadata={title:"Pendaftaran pelanggan"};
export default async function Page({params}:{params:Promise<{token:string}>}){const {token}=await params;return <PublicOnboardingForm token={token}/>}
