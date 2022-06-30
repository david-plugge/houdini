// externals
import * as recast from 'recast'
import * as typescriptPlugin from '@graphql-codegen/typescript'
import * as operationsPlugin from '@graphql-codegen/typescript-operations'
import { codegen } from '@graphql-codegen/core'
import * as graphql from 'graphql'
import fs from 'fs/promises'
import path from 'path'
import { ProgramKind, IdentifierKind } from 'ast-types/gen/kinds'
// locals
import { Config } from '../../../common'
import { CollectedGraphQLDocument } from '../../types'
import { scrubSelection, writeFile } from '../../utils'
import { readonlyProperty } from './types'
const AST = recast.types.builders

// typescriptGenerator generates typescript definitions for the artifacts
export default async function typescriptGenerator(
	config: Config,
	docs: CollectedGraphQLDocument[]
) {
	// the actual type definitions are going to be created
	const typeDefinitionsFile = await codegen({
		documents: docs
			.filter((doc) => doc.generateStore)
			.map(({ document }) => {
				return { document: scrubSelection(config, document) }
			}),
		config: {},
		schema: graphql.parse(graphql.printSchema(config.schema)),
		filename: '',
		plugins: [
			// Each plugin should be an object
			{
				typescript: {}, // Here you can pass configuration to the plugin
			},
			{
				operations: {
					fragmentMasking: true,
				},
			},
		],
		pluginMap: {
			typescript: typescriptPlugin,
			operations: operationsPlugin,
		},
	})
	await fs.writeFile(config.internalTypeDefinitionFile, typeDefinitionsFile, 'utf-8')

	// all that we need to do now is generate type definition files for each file that import
	// and use the appropriate types from the codegen// every document needs a generated type

	// build up a list of paths we have types in (to export from index.d.ts)
	const typePaths: string[] = []

	await Promise.all(
		// the generated types depend solely on user-provided information
		// so we need to use the original document that we haven't mutated
		// as part of the compiler
		docs.map(async ({ originalDocument, name, kind, generateArtifact }) => {
			if (!generateArtifact) {
				return
			}

			// the place to put the artifact's type definition
			const typeDefPath = config.artifactTypePath(originalDocument)

			// build up the program
			let program: ProgramKind

			// if there's an operation definition
			let definition = originalDocument.definitions.find(
				(def) =>
					(def.kind === 'OperationDefinition' || def.kind === 'FragmentDefinition') &&
					def.name?.value === name
			) as graphql.OperationDefinitionNode | graphql.FragmentDefinitionNode

			if (definition?.kind === 'OperationDefinition') {
				// treat it as an operation document
				program = await generateOperationTypeDefs(config, definition)
			} else {
				// treat it as a fragment document
				program = await generateFragmentTypeDefs(config, definition)
			}

			// write the file contents
			await writeFile(typeDefPath, recast.print(program).code)

			typePaths.push(typeDefPath)
		})
	)

	// now that we have every type generated, create an index file in the runtime root that exports the types
	const typeIndex = AST.program(
		typePaths
			.map((typePath) => {
				return AST.exportAllDeclaration(
					AST.literal(
						'./' +
							path
								.relative(path.resolve(config.typeIndexPath, '..'), typePath)
								// remove the .d.ts from the end of the path
								.replace(/\.[^/.]+\.[^/.]+$/, '')
					),
					null
				)
			})
			.concat([
				AST.exportAllDeclaration(AST.literal('./runtime'), null),
				AST.exportAllDeclaration(AST.literal('./stores'), null),
			])
	)

	// write the contents
	await writeFile(config.typeIndexPath, recast.print(typeIndex).code)
}

async function generateOperationTypeDefs(
	config: Config,
	definition: graphql.OperationDefinitionNode
) {
	const program = AST.program([])

	// the name of the types we will define
	const inputTypeName = `${definition.name!.value}$input`
	const shapeTypeName = `${definition.name!.value}$result`
	const afterLoadTypeName = `${definition.name!.value}$afterLoad`

	// look up the root type of the document
	let type: graphql.GraphQLNamedType | null | undefined
	const { operation } = definition
	if (operation === 'query') {
		type = config.schema.getQueryType()
	} else if (operation === 'mutation') {
		type = config.schema.getMutationType()
	} else if (operation === 'subscription') {
		type = config.schema.getSubscriptionType()
	}
	if (!type) {
		throw new Error('Could not find root type for document')
	}

	// dry
	const hasInputs = definition.variableDefinitions && definition.variableDefinitions.length > 0

	// we're going to need to input a few things:

	// the type defining the shape of the query
	const shapeType = AST.identifier(
		definition.name!.value + operation[0].toUpperCase() + operation.slice(1)
	)
	program.body.push(internalTypeImport(config, shapeType))

	// if we have inputs, we'll want to import the input shape
	if (hasInputs) {
		const inputType = AST.identifier(shapeType.name + 'Variables')

		program.body.push(internalTypeImport(config, inputType))

		// merge all of the variables into a single object
		program.body.push(
			AST.exportNamedDeclaration(
				AST.tsTypeAliasDeclaration(
					AST.identifier(inputTypeName),
					AST.tsTypeReference(inputType)
				)
			)
		)
	}

	// // the type describing the input
	program.body // add our types to the body
		.push(
			// add the root type named after the document that links the input and result types
			AST.exportNamedDeclaration(
				AST.tsTypeAliasDeclaration(
					AST.identifier(definition.name!.value),
					AST.tsTypeLiteral([
						readonlyProperty(
							AST.tsPropertySignature(
								AST.stringLiteral('input'),
								AST.tsTypeAnnotation(
									hasInputs
										? AST.tsTypeReference(AST.identifier(inputTypeName))
										: AST.tsNullKeyword()
								)
							)
						),
						readonlyProperty(
							AST.tsPropertySignature(
								AST.stringLiteral('result'),
								AST.tsTypeAnnotation(
									definition.operation === 'mutation'
										? AST.tsTypeReference(AST.identifier(shapeTypeName))
										: AST.tsUnionType([
												AST.tsTypeReference(AST.identifier(shapeTypeName)),
												AST.tsUndefinedKeyword(),
										  ])
								)
							)
						),
					])
				)
			),
			// export the type that describes the result
			AST.exportNamedDeclaration(
				AST.tsTypeAliasDeclaration(
					AST.identifier(shapeTypeName),
					AST.tsTypeReference(shapeType)
				)
			)
		)

	// generate type for the afterload function
	const properties: ReturnType<typeof readonlyProperty>[] = [
		readonlyProperty(
			AST.tsPropertySignature(
				AST.stringLiteral('data'),
				AST.tsTypeAnnotation(
					AST.tsTypeLiteral([
						readonlyProperty(
							AST.tsPropertySignature(
								AST.stringLiteral(definition.name!.value),
								AST.tsTypeAnnotation(
									AST.tsTypeReference(AST.identifier(shapeTypeName))
								)
							)
						),
					])
				)
			)
		),
	]

	if (hasInputs) {
		properties.splice(
			0,
			0,
			readonlyProperty(
				AST.tsPropertySignature(
					AST.stringLiteral('input'),
					AST.tsTypeAnnotation(
						AST.tsTypeLiteral([
							readonlyProperty(
								AST.tsPropertySignature(
									AST.stringLiteral(definition.name!.value),
									AST.tsTypeAnnotation(
										AST.tsTypeReference(AST.identifier(inputTypeName))
									)
								)
							),
						])
					)
				)
			)
		)
	}

	if (definition.operation === 'query') {
		program.body.push(
			AST.exportNamedDeclaration(
				AST.tsTypeAliasDeclaration(
					AST.identifier(afterLoadTypeName),
					AST.tsTypeLiteral(properties)
				)
			)
		)
	}

	return program
}

async function generateFragmentTypeDefs(
	config: Config,
	definition: graphql.FragmentDefinitionNode
): Promise<ProgramKind> {
	const program = AST.program([])

	// the name of the prop type
	const propTypeName = definition.name.value
	// the name of the shape type
	const shapeTypeName = `${definition.name.value}$data`

	// look up the root type of the document
	const type = config.schema.getType(definition.typeCondition.name.value)
	if (!type) {
		throw new Error('Should not get here')
	}

	const internalType = AST.identifier(definition.name.value + 'Fragment')

	// the first thing we need to do is import the corresponding type from the internal file
	program.body.push(internalTypeImport(config, internalType))

	program.body.push(
		// we need to add a type that will act as the entry point for the fragment
		// and be assigned to the prop that holds the reference passed from
		// the fragment's parent
		AST.exportNamedDeclaration(
			AST.tsTypeAliasDeclaration(
				AST.identifier(propTypeName),
				AST.tsTypeLiteral([
					readonlyProperty(
						AST.tsPropertySignature(
							AST.stringLiteral('shape'),
							AST.tsTypeAnnotation(
								AST.tsTypeReference(AST.identifier(shapeTypeName))
							),
							true
						)
					),
					readonlyProperty(
						AST.tsPropertySignature(
							AST.stringLiteral(fragmentKey),
							AST.tsTypeAnnotation(
								AST.tsTypeLiteral([
									AST.tsPropertySignature(
										AST.stringLiteral(propTypeName),
										AST.tsTypeAnnotation(
											AST.tsLiteralType(AST.booleanLiteral(true))
										)
									),
								])
							)
						)
					),
				])
			)
		),

		// export the type that describes the fragments response data
		AST.exportNamedDeclaration(
			AST.tsTypeAliasDeclaration(
				AST.identifier(shapeTypeName),
				AST.tsTypeReference(internalType)
			)
		)
	)

	return program
}

function internalTypeImport(config: Config, identifier: IdentifierKind) {
	return AST.importDeclaration(
		[AST.importSpecifier(identifier)],
		AST.stringLiteral('./' + config.internalTypeDefinitionFileName),
		'type'
	)
}

export const fragmentKey = '$fragments'
