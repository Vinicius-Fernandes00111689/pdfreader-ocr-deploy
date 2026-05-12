import { createFileRoute } from "@tanstack/react-router";
import PdfOcrApp from "@/components/PdfOcrApp";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <>
      <PdfOcrApp />
      <Toaster richColors position="top-right" />
    </>
  );
}
