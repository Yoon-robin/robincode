// shadcn/ui's Button, in the RobinX colors and V3.4's shapes (docs/brand.md
// 부품 더): the main action filled blue, the outline button on --raise, both
// 32 r8 (pressed as 36: ::after); the rest bare
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[8px] text-[13px] font-[500] transition-[color,background-color,border-color,opacity] duration-150 outline-none select-none after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-[''] focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-3.5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent-fill text-white font-[600] hover:bg-accent-hover",
        outline: "border border-line bg-raise text-text hover:bg-press hover:text-head",
        ghost: "text-soft hover:bg-white/[0.06] hover:text-head",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-8 px-3",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }) {
  return <button type="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Kbd({ className, ...props }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-b-2 border-line px-1 font-mono text-[10.5px] leading-none text-soft",
        className,
      )}
      {...props}
    />
  );
}
