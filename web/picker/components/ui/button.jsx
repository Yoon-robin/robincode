// shadcn/ui's Button, in the RobinX colors (white is the one light: the main
// action; the rest are outlined or bare)
import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-box text-[13px] font-medium transition-[color,background-color,border-color,opacity] duration-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-accent-fill text-white font-semibold hover:bg-[#2f5cd6]",
        outline: "border border-line bg-transparent text-text hover:border-white/40 hover:bg-white/[0.03]",
        ghost: "text-soft hover:bg-white/[0.06] hover:text-head",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-3",
        icon: "size-9",
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
