import type { CSSProperties, DOMAttributes, ReactNode, RefAttributes } from "react";
import type { IconName } from "maotaui/icons";

type Bool = boolean | undefined;
type Color = "primary" | "secondary" | "success" | "warning" | "danger" | "info" | "neutral";

interface MaoBase<E extends HTMLElement = HTMLElement> extends DOMAttributes<E>, RefAttributes<E> {
  id?: string;
  className?: string;
  style?: CSSProperties;
  slot?: string;
  hidden?: boolean;
  tabIndex?: number;
  title?: string;
  children?: ReactNode;
  [aria: `aria-${string}`]: string | number | boolean | undefined;
  [data: `data-${string}`]: string | number | boolean | undefined;
}

interface MaoButtonAttrs extends MaoBase {
  color?: Color;
  variant?: "solid" | "shadow" | "bordered" | "flat" | "light";
  size?: "sm" | "md" | "lg";
  loading?: Bool;
  disabled?: Bool;
  href?: string;
  block?: Bool;
  icon?: Bool;
}

interface MaoButtonGroupAttrs extends MaoBase {
  orientation?: "horizontal" | "vertical";
}

interface MaoLinkAttrs extends MaoBase {
  href?: string;
  target?: "_self" | "_blank";
  color?: Color;
  underline?: "always" | "hover" | "none";
  size?: "sm" | "md" | "lg";
  external?: Bool;
}

interface MaoCopyAttrs extends MaoBase {
  text?: string;
  label?: string;
  "copied-label"?: string;
  color?: Color;
  variant?: "light" | "solid";
  size?: "sm" | "md" | "lg";
  disabled?: Bool;
}

interface MaoReactionAttrs extends MaoBase {
  active?: Bool;
  count?: number | string;
  icon?: string;
  color?: string;
  size?: "sm" | "md" | "lg";
  label?: string;
}

interface MaoChipAttrs extends MaoBase {
  active?: Bool;
  disabled?: Bool;
  value?: string;
}

interface MaoSegmentedAttrs extends MaoBase {
  value?: string;
  label?: string;
  disabled?: Bool;
}

interface MaoSegmentAttrs extends MaoBase {
  value?: string;
  disabled?: Bool;
}

interface MaoTextFieldAttrs extends MaoBase {
  label?: string;
  hint?: string;
  value?: string;
  placeholder?: string;
  type?: string;
  name?: string;
  required?: Bool;
  disabled?: Bool;
  readonly?: Bool;
  invalid?: Bool;
  autocomplete?: string;
}

interface MaoTextAreaAttrs extends MaoTextFieldAttrs {
  rows?: number | string;
}

interface MaoSelectAttrs extends MaoBase {
  label?: string;
  hint?: string;
  options?: string;
  value?: string;
  placeholder?: string;
  name?: string;
  required?: Bool;
  disabled?: Bool;
}

interface MaoSwitchAttrs extends MaoBase {
  checked?: Bool;
  disabled?: Bool;
  name?: string;
  value?: string;
  size?: "sm" | "md";
}

interface MaoCheckboxAttrs extends MaoBase {
  checked?: Bool;
  indeterminate?: Bool;
  disabled?: Bool;
  name?: string;
  value?: string;
}

interface MaoIconAttrs extends MaoBase {
  name?: IconName;
  size?: number | string;
  label?: string;
  "stroke-width"?: number | string;
}

interface MaoBadgeAttrs extends MaoBase {
  tone?: "neutral" | "accent" | "danger" | "sage" | "blue" | "solid";
}

interface MaoAvatarAttrs extends MaoBase {
  label?: string;
  src?: string;
  alt?: string;
  size?: "sm" | "md" | "lg";
  tone?: "sage" | "blue" | "accent";
}

interface MaoProgressAttrs extends MaoBase {
  value?: number | string;
  max?: number | string;
  label?: string;
  "show-value"?: Bool;
  tone?: "accent" | "sage" | "blue";
}

interface MaoMetricAttrs extends MaoBase {
  label?: string;
  value?: string;
  trend?: string;
  tone?: "sage" | "danger";
}

interface MaoMiniChartAttrs extends MaoBase {
  values?: string;
  active?: number | string;
  label?: string;
  unit?: string;
  tone?: "sage" | "blue" | "accent";
}

interface MaoDividerAttrs extends MaoBase {
  orientation?: "horizontal" | "vertical";
  dashed?: Bool;
  color?: string;
}

interface MaoBrandAttrs extends MaoBase {
  name?: string;
  href?: string;
  "icon-src"?: string;
  "icon-alt"?: string;
}

interface MaoCardAttrs extends MaoBase {
  color?: Color;
  padding?: "sm" | "md" | "lg";
  bordered?: Bool;
  hoverable?: Bool;
  clickable?: Bool;
  transparent?: Bool;
  href?: string;
}

interface MaoHeaderAttrs extends MaoBase {
  name?: string;
  description?: string;
  level?: "1" | "2" | "3";
}

interface MaoScrollShadowAttrs extends MaoBase {
  axis?: "horizontal" | "vertical";
  "shadow-size"?: string;
  "shadow-color"?: string;
  scrollbar?: "none" | "thin";
  wheel?: Bool;
  draggable?: Bool;
}

interface MaoNoticeAttrs extends MaoBase {
  tone?: "info" | "sage" | "blue" | "accent" | "danger";
  title?: string;
}

interface MaoDialogAttrs extends MaoBase {
  open?: Bool;
  heading?: string;
  size?: "sm" | "md" | "lg";
  closable?: Bool;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "mao-button": MaoButtonAttrs;
      "mao-button-group": MaoButtonGroupAttrs;
      "mao-link": MaoLinkAttrs;
      "mao-copy": MaoCopyAttrs;
      "mao-reaction": MaoReactionAttrs;
      "mao-chip": MaoChipAttrs;
      "mao-segmented": MaoSegmentedAttrs;
      "mao-segment": MaoSegmentAttrs;
      "mao-text-field": MaoTextFieldAttrs;
      "mao-text-area": MaoTextAreaAttrs;
      "mao-select": MaoSelectAttrs;
      "mao-switch": MaoSwitchAttrs;
      "mao-checkbox": MaoCheckboxAttrs;
      "mao-icon": MaoIconAttrs;
      "mao-badge": MaoBadgeAttrs;
      "mao-avatar": MaoAvatarAttrs;
      "mao-progress": MaoProgressAttrs;
      "mao-metric": MaoMetricAttrs;
      "mao-mini-chart": MaoMiniChartAttrs;
      "mao-divider": MaoDividerAttrs;
      "mao-brand": MaoBrandAttrs;
      "mao-card": MaoCardAttrs;
      "mao-header": MaoHeaderAttrs;
      "mao-scroll-shadow": MaoScrollShadowAttrs;
      "mao-notice": MaoNoticeAttrs;
      "mao-dialog": MaoDialogAttrs;
    }
  }
}
