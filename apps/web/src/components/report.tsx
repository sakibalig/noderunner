"use client";

import { parts, readable } from "../state/citations.ts";
import { blocks } from "../state/markdown.ts";

type Props = {
  readonly report: string;
  readonly numberOf: (stepId: string) => number | null;
  readonly selected: string | null;
  readonly onCite: (stepId: string) => void;
};

/** Inline text with `code`, **bold**, and clickable [s:…] citations. */
function Inline({ text, ...props }: Props & { readonly text: string }) {
  return (
    <>
      {parts(text, props.numberOf).map((part, i) =>
        part.kind === "cite" ? (
          <button
            key={`${part.stepId}-${i}`}
            type="button"
            className={`cite${props.selected === part.stepId ? " on" : ""}`}
            onClick={() => props.onCite(part.stepId)}
            title="Show this step's evidence"
          >
            {part.n}
          </button>
        ) : (
          part.text
            .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
            .map((chunk, j) =>
              chunk.startsWith("`") ? (
                <code key={`${i}-${j}`}>{chunk.slice(1, -1)}</code>
              ) : chunk.startsWith("**") ? (
                <strong key={`${i}-${j}`}>{chunk.slice(2, -2)}</strong>
              ) : (
                chunk
              ),
            )
        ),
      )}
    </>
  );
}

export function Report(props: Props) {
  if (props.report === "") return <p className="sub">The agent is working…</p>;
  return (
    <div className="report">
      {blocks(readable(props.report)).map((block, i) => {
        const key = `${block.kind}-${i}`;
        if (block.kind === "heading")
          return block.level === 2 ? <h3 key={key}>{block.text}</h3> : <h4 key={key}>{block.text}</h4>;
        if (block.kind === "list")
          return (
            <ul key={key}>
              {block.items.map((item, j) => (
                <li key={`${key}-${j}`}>
                  <Inline {...props} text={item} />
                </li>
              ))}
            </ul>
          );
        if (block.kind === "table")
          return (
            <table key={key}>
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th key={`${key}-h${j}`}>{cell}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={`${key}-r${r}`}>
                    {row.map((cell, j) => (
                      <td key={`${key}-r${r}-${j}`}>
                        <Inline {...props} text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        return (
          <p key={key}>
            <Inline {...props} text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
