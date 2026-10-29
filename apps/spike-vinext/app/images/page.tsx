import Image from "next/image";
import gradient from "@/public/gradient.png";

export default function ImagesPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
      <h1 className="text-3xl font-semibold">next/image</h1>
      <h2 className="font-semibold">Static import</h2>
      <Image src={gradient} alt="Gradient (static import)" sizes="(max-width: 640px) 100vw, 640px" />
      <h2 className="font-semibold">Public path</h2>
      <Image src="/gradient.png" alt="Gradient (public path)" width={640} height={360} />
      <h2 className="font-semibold">Remote</h2>
      <Image
        src="https://images.unsplash.com/photo-1500530855697-b586d89ba3ee"
        alt="Remote image"
        width={640}
        height={427}
      />
    </main>
  );
}
