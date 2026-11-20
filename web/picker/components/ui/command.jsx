// shadcn/ui's Command (cmdk, the command menu of Raycast and Linear), in the
// RobinX colors. The list here is the server's, so filtering is off
// (shouldFilter={false} where it is used).
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "../../lib/utils";

export function Command({ className, ...props }) {
  return <CommandPrimitive className={cn("flex h-full w-full flex-col overflow-hidden bg-page text-text", className)} {...props} />;
}

export function CommandInput({ className, ...props }) {
  return (
    <CommandPrimitive.Input
      className={cn(
        "h-full w-full min-w-0 bg-transparent font-mono text-[13px] text-white caret-white outline-none placeholder:font-sans placeholder:text-faint",
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }) {
  return (
    <CommandPrimitive.List
      className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-2", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, ...props }) {
  return <CommandPrimitive.Empty className={cn("px-4 py-8 text-center text-[13px] text-faint", className)} {...props} />;
}

export function CommandGroup({ className, ...props }) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:justify-between [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint [&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col [&_[cmdk-group-items]]:gap-1",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }) {
  return (
    <CommandPrimitive.Item
      className={cn("relative flex cursor-default items-center rounded-[8px] outline-none select-none data-[disabled=true]:opacity-40", className)}
      {...props}
    />
  );
}
