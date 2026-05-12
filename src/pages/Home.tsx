import PdfOcrApp from "@/components/PdfOcrApp";
import { Toaster } from "@/components/ui/sonner";

function Home() {
  return (
    <>
      <PdfOcrApp />
      <Toaster richColors position="top-right" />
    </>
  );
}

export default Home;
