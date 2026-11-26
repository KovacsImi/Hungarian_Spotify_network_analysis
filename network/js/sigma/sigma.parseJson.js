// Scott Hale (Oxford Internet Institute)
// Requires sigma.js and jquery to be loaded
// based on parseGexf from Mathieu Jacomy @ Sciences Po Medialab & WebAtlas

sigma.publicPrototype.parseJson = function(jsonPath,callback) {
	var sigmaInstance = this;
	jQuery.getJSON(jsonPath, function(data) {
		var nodeColors = {};
		for (var i = 0; i < data.nodes.length; i++) {
			var id = data.nodes[i].id;
			var c = data.nodes[i].color;
			if (c) {
				var m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(c);
				nodeColors[id] = m ? "rgba(" + m[1] + "," + m[2] + "," + m[3] + ",0.7)" : c;
			}
			sigmaInstance.addNode(id, data.nodes[i]);
		}

		for (var j = 0; j < data.edges.length; j++) {
			var edgeNode = data.edges[j];
			var source = edgeNode.source;
			var target = edgeNode.target;
			var eid = edgeNode.id;

			if (
				(!edgeNode.color ||
					edgeNode.color === "rgb(0,0,0)" ||
					edgeNode.color === "rgb(0, 0, 0)" ||
					edgeNode.color === "#000" ||
					edgeNode.color === "#000000") &&
				nodeColors[source]
			) {
				edgeNode.color = nodeColors[source];
			}

			sigmaInstance.addEdge(eid, source, target, edgeNode);
		}

		if (callback) callback.call(this);//Trigger the data ready function
	});//end jquery getJSON function
};//end sigma.parseJson function
