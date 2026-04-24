import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import './Tooltip.css';

type Side = 'top' | 'right' | 'bottom' | 'left';
type Align = 'start' | 'center' | 'end';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  delayDuration = 200,
  disabled = false,
}: TooltipProps) {
  if (disabled || content == null || content === '') {
    return <>{children}</>;
  }
  return (
    <RadixTooltip.Provider delayDuration={delayDuration} skipDelayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            className="ui-tooltip"
            side={side}
            align={align}
            sideOffset={sideOffset}
            collisionPadding={8}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

interface TooltipProviderProps {
  children: ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}

export function TooltipProvider({
  children,
  delayDuration = 200,
  skipDelayDuration = 300,
}: TooltipProviderProps) {
  return (
    <RadixTooltip.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      {children}
    </RadixTooltip.Provider>
  );
}
