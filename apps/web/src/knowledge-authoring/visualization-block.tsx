import type { RelationshipNeighborhood } from "@stash/domain-types";
import { Link } from "react-router";
import styles from "./note-tree.module.css";

export type BuiltInRelationshipRenderer = "focused";
interface RelationshipRenderer {
  readonly id: BuiltInRelationshipRenderer;
  render(neighborhood: RelationshipNeighborhood): React.ReactNode;
}
const renderers: Readonly<Record<BuiltInRelationshipRenderer, RelationshipRenderer>> = Object.freeze({
  focused: Object.freeze({ id: "focused", render: (neighborhood: RelationshipNeighborhood) => <div aria-hidden="true" className={styles.relationshipVisual}
    data-renderer="focused" data-testid="relationship-visual">
    {neighborhood.nodes.map((node) => <span className={node.id === neighborhood.rootId ? styles.relationshipRoot : ""}
      key={node.id} style={{ "--relationship-depth": node.depth } as React.CSSProperties}>{node.title}</span>)}
  </div> }),
});

/** The visual lens and its complete non-spatial equivalent consume the same permission-filtered response. */
export function VisualizationBlock({ neighborhood, renderer = "focused" }: {
  neighborhood: RelationshipNeighborhood; renderer?: BuiltInRelationshipRenderer;
}) {
  return <div className={styles.visualizationBlock}>
    {renderers[renderer].render(neighborhood)}
    <ol aria-label="Related Notes outline" className={styles.relationshipOutline}>
      {neighborhood.outline.map((node) => <li key={node.id} style={{ "--relationship-depth": node.depth } as React.CSSProperties}>
        {node.id === neighborhood.rootId ? <span aria-current="true">{node.title}</span>
          : <Link to={`/app/notes/${node.id}`}>{node.title}</Link>}
        <small>{node.depth === 0 ? "Focused Note" : `${node.depth} ${node.depth === 1 ? "step" : "steps"} away`}</small>
      </li>)}
    </ol>
  </div>;
}
