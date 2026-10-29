# The shared look of the architecture pictures (docs/diagrams/*.py): fonts and
# colours, a node that is an icon with a bold name and detail lines under it,
# cluster boxes for tenants and resource groups, and edge styles. Every picture
# imports it, so it is part of their fingerprint in rendered.json together with
# the Dockerfile: change it and docs:check asks for a new render of all of them.
# The icons are the official Microsoft Azure architecture icons as the diagrams
# library ships them, drawn as they are (never cropped, flipped or recoloured).
import html
import re
from pathlib import Path

from diagrams import Cluster, Diagram, Edge, Node, getdiagram

FONT = "DejaVu Sans"
INK = "#1b2533"  # names and cluster titles
MUTED = "#475569"  # detail lines and edge labels
LINE = "#64748b"  # edges
FRAME = "#cbd5e1"  # borders of boxes and clusters
FAINT = "#94a3b8"  # dashed frames: made only when enabled, or added later
ICON_PT = 52  # icon side, in points
TITLE_ICON_PT = 22  # icon in a cluster title


def picture(file, direction="TB", **graph_attr):
    """The Diagram for a source file: PNG next to it with the same name, white, portrait unless told otherwise."""
    attrs = {
        "bgcolor": "white", "pad": "0.4", "nodesep": "0.45", "ranksep": "0.6", "dpi": "144",
        "splines": "spline", "compound": "true", "newrank": "true",
        "fontname": FONT, "fontsize": "13", "fontcolor": INK, **graph_attr,
    }
    return Diagram(
        "", filename=Path(file).stem, show=False, direction=direction, graph_attr=attrs,
        node_attr={"shape": "plain", "fixedsize": "false", "width": "0", "height": "0", "margin": "0",
                   "fontname": FONT, "fontsize": "13", "fontcolor": INK},
        edge_attr={"fontname": FONT, "fontsize": "11", "fontcolor": MUTED, "color": LINE, "penwidth": "1.1", "arrowsize": "0.7"},
    )


def _esc(s):
    """HTML-label text: escaped, a newline becomes a line break."""
    return html.escape(str(s), quote=False).replace("\n", "<br/>")


def _caption(title, lines):
    rows = [f'<tr><td><font point-size="13"><b>{_esc(title)}</b></font></td></tr>']
    if lines:
        rows.append(f'<tr><td><font point-size="11" color="{MUTED}">{"<br/>".join(_esc(l) for l in lines)}</font></td></tr>')
    return "".join(rows)


def _table(rows):
    return f'<<table border="0" cellborder="0" cellspacing="0" cellpadding="1">{rows}</table>>'


def _img(kind, side):
    return f'<td fixedsize="true" width="{side}" height="{side}"><img src="{Node._load_icon(kind)}"/></td>'


def icon(kind, title, *lines, optional=False, **attrs):
    """A node drawn as an icon (a diagrams node class) with its name in bold and detail lines under it.
    optional=True frames it dashed: it exists only when enabled, or comes later."""
    a = {"label": _table(f"<tr>{_img(kind, ICON_PT)}</tr>" + _caption(title, lines))}
    if optional:
        a.update(shape="box", style="dashed,rounded", color=FAINT, margin="0.1,0.06")
    a.update(attrs)
    return Node(**a)


def text(title, *lines, optional=False, **attrs):
    """A node with no icon, a rounded box: for things that have no honest icon (a file, a setting, a role list)."""
    a = {"label": _table(_caption(title, lines)), "shape": "box", "style": "rounded,filled", "fillcolor": "#ffffff",
         "color": FRAME, "margin": "0.14,0.08"}
    if optional:
        a.update(style="rounded,dashed", color=FAINT)
    a.update(attrs)
    return Node(**a)


_LOOKS = {
    "tenant": {"bgcolor": "#f1f5f9", "pencolor": FAINT},
    "box": {"bgcolor": "#ffffff", "pencolor": FRAME},
    "plain": {"bgcolor": "#f8fafc", "pencolor": FRAME},
    "optional": {"bgcolor": "#ffffff", "pencolor": FAINT, "style": "rounded,dashed"},
}


def group(label, kind="box", icon=None, **graph_attr):
    """A cluster box with a bold title, optionally with an icon in front of it.
    kind: tenant (tinted), box (white), plain (faint grey) or optional (dashed)."""
    cells = (_img(icon, TITLE_ICON_PT) if icon else "") + \
        f'<td align="left" balign="left"><font point-size="13"><b>{_esc(label)}</b></font></td>'
    title = f'<table border="0" cellborder="0" cellspacing="0" cellpadding="2"><tr>{cells}</tr></table>'
    attrs = {"style": "rounded", "margin": "14", "fontname": FONT, "fontsize": "13", "fontcolor": INK,
             "labeljust": "l", "label": f"<{title}>", **_LOOKS[kind], **graph_attr}
    # The cluster's dot name comes from its label; a plain one keeps lhead/ltail references simple.
    return Cluster(re.sub(r"[^A-Za-z0-9]+", "_", label), graph_attr=attrs)


def link(label="", dashed=False, **attrs):
    """An edge, optionally labelled (a newline breaks the label); dashed for optional or later ties.
    a >> link() >> b is an arrow, a - link() - b a plain line, a << link() << b an arrow pointing back
    at a (the library sets the direction from the operator). lhead=cluster.name ends it at a cluster's border."""
    a = {"label": label.replace("\n", "\\n")}
    if dashed:
        a["style"] = "dashed"
    a.update(attrs)
    return Edge(**a)


def same_rank(*nodes):
    """Puts the nodes on one row (TB) or one column (LR)."""
    with getdiagram().dot.subgraph() as s:
        s.attr(rank="same")
        for n in nodes:
            s.node(n.nodeid)


def order(*nodes, weight=1):
    """Stacks the nodes under each other (TB) with invisible edges, to keep a list narrow.
    A higher weight pulls them into one straight column."""
    for a, b in zip(nodes, nodes[1:]):
        a >> Edge(style="invis", weight=str(weight)) >> b


def row(*nodes):
    """Puts the nodes on one row, left to right in this order."""
    same_rank(*nodes)
    order(*nodes)
