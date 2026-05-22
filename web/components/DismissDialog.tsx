"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";

interface DismissDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (until: Date, reason: string) => void;
  loading?: boolean;
}

export function DismissDialog({
  open,
  onOpenChange,
  onConfirm,
  loading = false,
}: DismissDialogProps) {
  const [date, setDate] = React.useState<Date | undefined>(undefined);
  const [reason, setReason] = React.useState("");

  function handleConfirm() {
    if (!date) return;
    onConfirm(date, reason);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Dismiss until…</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            disabled={(d) => d < new Date()}
            className="rounded-md border mx-auto"
          />

          <div className="grid gap-1.5">
            <Label htmlFor="dismiss-reason">Reason (optional)</Label>
            <Input
              id="dismiss-reason"
              placeholder="e.g. Content is still accurate"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!date || loading}>
            {loading ? "Dismissing…" : "Dismiss"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
