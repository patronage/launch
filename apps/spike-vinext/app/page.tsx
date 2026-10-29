import Link from "next/link";

import { now } from "@/lib/content";

export const revalidate = 300;

const Home = () => (
  <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
    <h1 className="text-3xl font-semibold">vinext spike</h1>
    <p>Rendered at {now()} (ISR, 300s).</p>
    <ul className="list-disc pl-6">
      <li>
        <Link href="/posts/hello">Dynamic route: /posts/hello</Link>
      </li>
      <li>
        <Link href="/images">next/image</Link>
      </li>
      <li>
        <a href="/api/hello">API route: /api/hello</a>
      </li>
    </ul>
  </main>
);

export default Home;
