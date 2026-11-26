(function () {
    "use strict";

    var DRAG_THRESHOLD_PX = 4;

    function attachDragNodesPlugin(core) {
        var graph = core.graph;
        var plotter = core.plotter;
        var mouseDom = core.domElements.mouse;
        var nodeDom = core.domElements.nodes;
        var labelDom = core.domElements.labels;
        var hoverDom = core.domElements.hover;
        var nodeCtx = nodeDom.getContext("2d");
        var labelCtx = labelDom.getContext("2d");
        var hoverCtx = hoverDom.getContext("2d");

        var dragEnabled = true;
        var dragState = null;
        var initialBounds = null;
        var currentScaleA = 1;
        var adjacency = null;
        var adjacencyEdgeCount = -1;
        var pendingDragRaf = null;

        var origRescale = graph.rescale;

        function computeBounds(nodes) {
            var minX = Infinity;
            var maxX = -Infinity;
            var minY = Infinity;
            var maxY = -Infinity;
            var maxSize = 0;

            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.x < minX) minX = n.x;
                if (n.x > maxX) maxX = n.x;
                if (n.y < minY) minY = n.y;
                if (n.y > maxY) maxY = n.y;
                if (n.size > maxSize) maxSize = n.size;
            }

            return {
                minX: minX,
                maxX: maxX,
                minY: minY,
                maxY: maxY,
                maxSize: maxSize || 1,
            };
        }

        // Freeze initial graph bounding box (autoRescale: "once" behavior)
        // so dragging a node does not rescale or shift the rest of the graph.
        graph.rescale = function (w, h, doNodes, doEdges) {
            if (doNodes && !initialBounds && graph.nodes.length > 0) {
                initialBounds = computeBounds(graph.nodes);
            }

            origRescale.call(graph, w, h, doNodes, doEdges);

            if (doNodes && initialBounds) {
                var b = initialBounds;
                var l = b.maxX;
                var g = b.minX;
                var t = b.maxY;
                var s = b.minY;
                var outside = graph.p.scalingMode === "outside";

                var rawA = outside
                    ? Math.max(w / Math.max(l - g, 1), h / Math.max(t - s, 1))
                    : Math.min(w / Math.max(l - g, 1), h / Math.max(t - s, 1));
                var pad = (graph.p.maxNodeSize || b.maxSize) / rawA;

                l += pad;
                g -= pad;
                t += pad;
                s -= pad;

                var A = outside
                    ? Math.max(w / Math.max(l - g, 1), h / Math.max(t - s, 1))
                    : Math.min(w / Math.max(l - g, 1), h / Math.max(t - s, 1));

                currentScaleA = A;

                var midX = (l + g) / 2;
                var midY = (t + s) / 2;
                var nodes = graph.nodes;
                for (var i = 0; i < nodes.length; i++) {
                    var n = nodes[i];
                    if (!n.fixed) {
                        n.displayX = (n.x - midX) * A + w / 2;
                        n.displayY = (n.y - midY) * A + h / 2;
                    }
                }
            }

            return graph;
        };

        function getLocalMouse(e) {
            var rect = mouseDom.getBoundingClientRect();
            return {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top,
            };
        }

        function findNodeAt(mx, my) {
            var nodes = graph.nodes;
            for (var i = nodes.length - 1; i >= 0; i--) {
                var n = nodes[i];
                if (n.hidden) continue;
                var hitR = Math.max(n.displaySize || 0, 6);
                var dx = n.displayX - mx;
                var dy = n.displayY - my;
                if (dx * dx + dy * dy <= hitR * hitR) {
                    return n;
                }
            }
            return null;
        }

        function getAdjacentEdges(node) {
            var edges = graph.edges;
            if (!adjacency || adjacencyEdgeCount !== edges.length) {
                adjacency = {};
                adjacencyEdgeCount = edges.length;
                for (var i = 0; i < edges.length; i++) {
                    var e = edges[i];
                    var sid = e.source && e.source.id;
                    var tid = e.target && e.target.id;
                    if (sid !== undefined) {
                        (adjacency[sid] || (adjacency[sid] = [])).push(e);
                    }
                    if (tid !== undefined && tid !== sid) {
                        (adjacency[tid] || (adjacency[tid] = [])).push(e);
                    }
                }
            }
            return adjacency[node.id] || [];
        }

        function drawDragPreview(node) {
            nodeCtx.clearRect(0, 0, nodeDom.width, nodeDom.height);
            labelCtx.clearRect(0, 0, labelDom.width, labelDom.height);
            hoverCtx.clearRect(0, 0, hoverDom.width, hoverDom.height);

            // Draw only edges adjacent to the dragged node via cached adjacency lookup
            var edges = getAdjacentEdges(node);
            var ratio = core.mousecaptor && core.mousecaptor.ratio ? core.mousecaptor.ratio : 1;
            var allowCurve = ratio >= 1.8;
            hoverCtx.save();
            for (var i = 0; i < edges.length; i++) {
                var e = edges[i];
                if (e.hidden || e.source.hidden || e.target.hidden) continue;

                var sx = e.source.displayX;
                var sy = e.source.displayY;
                var tx = e.target.displayX;
                var ty = e.target.displayY;
                var edgeColor =
                    e.color ||
                    (plotter.p.edgeColor === "source"
                        ? e.source.color
                        : plotter.p.edgeColor === "target"
                          ? e.target.color
                          : plotter.p.defaultEdgeColor) ||
                    "#888";

                hoverCtx.strokeStyle = edgeColor;
                hoverCtx.lineWidth = Math.max(0.8, (e.displaySize || 1) / 2);
                hoverCtx.beginPath();
                if (allowCurve && (e.type || plotter.p.defaultEdgeType) === "curve") {
                    hoverCtx.moveTo(sx, sy);
                    hoverCtx.quadraticCurveTo(
                        (sx + tx) / 2 + (ty - sy) / 4,
                        (sy + ty) / 2 + (sx - tx) / 4,
                        tx,
                        ty
                    );
                } else {
                    hoverCtx.moveTo(sx, sy);
                    hoverCtx.lineTo(tx, ty);
                }
                hoverCtx.stroke();
            }
            hoverCtx.restore();

            if (core.p.lastNodes) {
                plotter.currentNodeIndex = 0;
                while (plotter.task_drawNode()) {}
            }
            if (core.p.lastLabels) {
                plotter.currentLabelIndex = 0;
                while (plotter.task_drawLabel()) {}
            }

            plotter.drawHoverNode(node);
        }

        function scheduleDragPreview(node) {
            if (typeof window.requestAnimationFrame !== "function") {
                drawDragPreview(node);
                return;
            }
            if (pendingDragRaf !== null) return;
            pendingDragRaf = window.requestAnimationFrame(function () {
                pendingDragRaf = null;
                if (dragState && dragState.dragged && dragState.node === node) {
                    drawDragPreview(node);
                }
            });
        }

        // Capture phase on core.domRoot runs BEFORE mousecaptor on mouseDom
        core.domRoot.addEventListener(
            "mousedown",
            function (e) {
                if (!dragEnabled || e.button !== 0 || !core.mousecaptor.config("mouseEnabled")) {
                    return;
                }
                var pos = getLocalMouse(e);
                var hit = findNodeAt(pos.x, pos.y);
                if (!hit) return;

                dragState = {
                    node: hit,
                    startX: pos.x,
                    startY: pos.y,
                    lastX: pos.x,
                    lastY: pos.y,
                    dragged: false,
                };
                mouseDom.style.cursor = "grabbing";
                e.stopPropagation();
                e.preventDefault();
            },
            true
        );

        document.addEventListener(
            "mousemove",
            function (e) {
                if (!dragState) return;
                e.stopPropagation();
                e.preventDefault();

                var pos = getLocalMouse(e);
                if (
                    !dragState.dragged &&
                    Math.hypot(pos.x - dragState.startX, pos.y - dragState.startY) > DRAG_THRESHOLD_PX
                ) {
                    dragState.dragged = true;
                }

                if (dragState.dragged) {
                    var dx = pos.x - dragState.lastX;
                    var dy = pos.y - dragState.lastY;
                    var totalScale = (currentScaleA || 1) * (core.mousecaptor.ratio || 1);

                    dragState.node.x += dx / totalScale;
                    dragState.node.y += dy / totalScale;
                    dragState.node.displayX += dx;
                    dragState.node.displayY += dy;
                    dragState.lastX = pos.x;
                    dragState.lastY = pos.y;

                    scheduleDragPreview(dragState.node);
                }
            },
            true
        );

        document.addEventListener(
            "mouseup",
            function (e) {
                if (!dragState) return;
                e.stopPropagation();
                e.preventDefault();

                if (pendingDragRaf !== null && typeof window.cancelAnimationFrame === "function") {
                    window.cancelAnimationFrame(pendingDragRaf);
                    pendingDragRaf = null;
                }

                var finished = dragState;
                dragState = null;
                mouseDom.style.cursor = "pointer";

                if (finished.dragged) {
                    core.draw(
                        core.p.auto ? 2 : core.p.drawNodes,
                        core.p.auto ? 1 : core.p.drawEdges,
                        core.p.auto ? 2 : core.p.drawLabels
                    );
                } else {
                    // Preserve standard click behavior to open Information Pane
                    core.dispatch("upnodes", [finished.node.id]);
                }
            },
            true
        );

        core._dragNodesControl = {
            setEnabled: function (val) {
                dragEnabled = !!val;
            },
            isEnabled: function () {
                return dragEnabled;
            },
        };
    }

    sigma.addPlugin(
        "enableNodeDrag",
        function (val) {
            if (typeof val === "undefined") {
                return this._core._dragNodesControl
                    ? this._core._dragNodesControl.isEnabled()
                    : true;
            }
            if (this._core._dragNodesControl) {
                this._core._dragNodesControl.setEnabled(val);
            }
            return this;
        },
        attachDragNodesPlugin
    );
})();
