import Link from "next/link";

import { getFrontendPayload } from "@/lib/payload";

export const dynamic = "force-dynamic";

const HomePage = async () => {
  const { payload, user } = await getFrontendPayload();

  const [settings, pages] = await Promise.all([
    payload.findGlobal({ overrideAccess: false, slug: "site-settings", user }),
    payload.find({
      collection: "pages",
      depth: 0,
      overrideAccess: false,
      select: { slug: true, title: true },
      sort: "title",
      user,
    }),
  ]);

  return (
    <div className="home">
      <div className="content">
        <h1>{settings.siteName}</h1>
        {settings.tagline && <p>{settings.tagline}</p>}
        <ul data-testid="pages">
          {pages.docs.map((page) => (
            <li key={page.id}>
              <Link href={`/${page.slug}`}>{page.title}</Link>
            </li>
          ))}
        </ul>
        <div className="links">
          <a className="admin" href="/admin">
            {user ? `Admin (${user.email})` : "Admin"}
          </a>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
