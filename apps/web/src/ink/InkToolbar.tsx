import { Eraser, Highlighter, PenLine, Redo2, Undo2 } from "lucide-react";

export type InkTool = "pen" | "highlighter" | "eraser";

const colors = [
  { value: "#1d2529", label: "黑色" },
  { value: "#176f6b", label: "绿色" },
  { value: "#2f5f9d", label: "蓝色" },
  { value: "#a6473c", label: "红色" },
];

export function InkToolbar({ tool, color, width, canUndo, canRedo, disabled, onTool, onColor, onWidth, onUndo, onRedo }: {
  tool: InkTool;
  color: string;
  width: number;
  canUndo: boolean;
  canRedo: boolean;
  disabled: boolean;
  onTool(tool: InkTool): void;
  onColor(color: string): void;
  onWidth(width: number): void;
  onUndo(): void;
  onRedo(): void;
}) {
  return <div className="ink-toolbar" role="toolbar" aria-label="手写工具">
    <button className="icon-button" aria-label="笔" title="笔" aria-pressed={tool === "pen"} disabled={disabled} onClick={() => onTool("pen")}><PenLine size={19} /></button>
    <button className="icon-button" aria-label="荧光笔" title="荧光笔" aria-pressed={tool === "highlighter"} disabled={disabled} onClick={() => onTool("highlighter")}><Highlighter size={19} /></button>
    <button className="icon-button" aria-label="橡皮" title="整笔橡皮" aria-pressed={tool === "eraser"} disabled={disabled} onClick={() => onTool("eraser")}><Eraser size={19} /></button>
    <span className="ink-toolbar-divider" />
    <div className="ink-swatches" aria-label="颜色">
      {colors.map((item) => <button
        key={item.value}
        className="ink-swatch"
        aria-label={item.label}
        title={item.label}
        aria-pressed={color === item.value}
        disabled={disabled}
        style={{ backgroundColor: item.value }}
        onClick={() => onColor(item.value)}
      />)}
    </div>
    <label className="ink-width">粗细<input aria-label="笔迹粗细" type="range" min="1" max="24" step="1" value={width} disabled={disabled} onChange={(event) => onWidth(Number(event.target.value))} /></label>
    <span className="ink-toolbar-spacer" />
    <button className="icon-button" aria-label="撤销" title="撤销" disabled={disabled || !canUndo} onClick={onUndo}><Undo2 size={19} /></button>
    <button className="icon-button" aria-label="重做" title="重做" disabled={disabled || !canRedo} onClick={onRedo}><Redo2 size={19} /></button>
  </div>;
}
