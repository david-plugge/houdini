import * as graphql from 'graphql'
import { Config } from '../../common'

export function scrubSelection(config: Config, document: graphql.ASTNode) {
	// before we can print the document, we need to strip:
	// 1. all references to internal directives
	// 2. all variables only used by internal directives
	const usedVariableNames = new Set<string>()
	let documentWithoutInternalDirectives = graphql.visit(document, {
		Directive(node) {
			// if the directive is one of the internal ones, remove it
			if (config.isInternalDirective(node)) {
				return null
			}
		},

		Variable(node, _key, parent) {
			const variableIsBeingDefined =
				parent && !(parent instanceof Array) && parent.kind === 'VariableDefinition'

			if (!variableIsBeingDefined) {
				usedVariableNames.add(node.name.value)
			}
		},
	})

	return graphql.visit(documentWithoutInternalDirectives, {
		VariableDefinition(variableDefinitionNode) {
			const name = variableDefinitionNode.variable.name.value

			if (!usedVariableNames.has(name)) {
				return null
			}
		},
	})
}
