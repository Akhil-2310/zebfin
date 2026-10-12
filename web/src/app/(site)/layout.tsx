import { SiteNav } from "@/components/SiteNav";

/** Sign-in, sign-up, recovery and invite pages share the public navbar. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav />
      {children}
    </>
  );
}
