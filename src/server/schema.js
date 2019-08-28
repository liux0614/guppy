import { gql } from 'apollo-server-express';
import log from './logger';
import { firstLetterUpperCase } from './utils/utils';

const esgqlTypeMapping = {
  text: 'String',
  keyword: 'String',
  integer: 'Int',
  long: 'Float',
  short: 'Int',
  byte: 'Int',
  double: 'Float',
  float: 'Float',
  half_float: 'Float',
  scaled_float: 'Float',
  array: 'Object',
  nested: 'Object',
};

const getGQLType = (esInstance, esIndex, field, esFieldType) => {
  const gqlType = esgqlTypeMapping[esFieldType];
  if (!gqlType) {
    throw new Error(`Invalid type ${esFieldType} for field ${field} in index ${esIndex}`);
  }
  const isArrayField = esInstance.isArrayField(esIndex, field);
  if (isArrayField) {
    return `[${gqlType}]`;
  }
  if (esFieldType === 'nested') {
    return `[${field}]`;
  }
  return gqlType;
};

const EnumAggsHistogramName = {
  HISTOGRAM_FOR_STRING: 'HistogramForString',
  HISTOGRAM_FOR_NUMBER: 'HistogramForNumber',
};
const gqlTypeToAggsHistogramName = {
  String: EnumAggsHistogramName.HISTOGRAM_FOR_STRING,
  Int: EnumAggsHistogramName.HISTOGRAM_FOR_NUMBER,
  Float: EnumAggsHistogramName.HISTOGRAM_FOR_NUMBER,
  '[String]': EnumAggsHistogramName.HISTOGRAM_FOR_STRING,
  '[Int]': EnumAggsHistogramName.HISTOGRAM_FOR_NUMBER,
  '[Float]': EnumAggsHistogramName.HISTOGRAM_FOR_NUMBER,
};

const getAggsHistogramName = (gqlType) => {
  if (!gqlTypeToAggsHistogramName[gqlType]) {
    // throw new Error(`Invalid elasticsearch type ${gqlType}`);
    return ``;
  }
  return gqlTypeToAggsHistogramName[gqlType];
};

const getQuerySchemaForType = (esInstance, esIndex, esType) => {
  const esTypeObjName = firstLetterUpperCase(esType);
  const fieldESTypeMap = esInstance.getESFieldTypeMappingByIndex(esIndex);
  const existingFields = new Set([]);

  const queueFields = [];
  Object.keys(fieldESTypeMap).forEach((field) => {
    const esFieldType = fieldESTypeMap[field].type;
    if (esFieldType === 'nested' && !existingFields.has(field)) {
      queueFields.push(field);
      existingFields.add(field);
    }
  });
  let sType = `${esType} (
    offset: Int, 
    first: Int,
    filter: JSON,
    sort: JSON,
    accessibility: Accessibility=all,
    ): [${esTypeObjName}]`;
  while (queueFields.length > 0) {
    const f = queueFields.shift();
    sType += `

    ${f} (
      offset: Int, 
      first: Int,
      filter: JSON,
      sort: JSON,
      accessibility: Accessibility=all,
    ):  [${firstLetterUpperCase(f)}]`;
  }
  return `${sType}
  `;
};

// eslint-disable-next-line max-len
const getFieldGQLTypeMapForProperties = (esInstance, esIndex, properties) => Object.keys(properties).map((field) => {
  const gqlType = getGQLType(esInstance, esIndex, field, properties[field].type);
  return { field, type: gqlType };
});

const getFieldGQLTypeMapForOneIndex = (esInstance, esIndex) => {
  const fieldESTypeMap = esInstance.getESFieldTypeMappingByIndex(esIndex);
  return getFieldGQLTypeMapForProperties(esInstance, esIndex, fieldESTypeMap);
};

const getTypeSchemaForOneIndex = (esInstance, esIndex, esType) => {
  const fieldGQLTypeMap = getFieldGQLTypeMapForOneIndex(esInstance, esIndex);
  const fieldESTypeMap = esInstance.getESFieldTypeMappingByIndex(esIndex);
  const esTypeObjName = firstLetterUpperCase(esType);
  const existingFields = new Set([]);

  const queueTypes = [];
  Object.keys(fieldESTypeMap).forEach((field) => {
    const esFieldType = fieldESTypeMap[field].type;
    if (esFieldType === 'nested' && !existingFields.has(field)) {
      queueTypes.push({ type: field, props: fieldESTypeMap[field].properties });
      existingFields.add(field);
    }
  });
  // console.info(fieldESTypeMap);
  // console.info(queueTypes);

  let sTypeSchema = `
    type ${esTypeObjName} {
      ${fieldGQLTypeMap.map(entry => `${entry.field}: ${entry.type},`).join('\n')}
      _matched: [MatchedItem]
    }
  `;
  while (queueTypes.length > 0) {
    const t = queueTypes.shift();
    const gqlTypes = getFieldGQLTypeMapForProperties(esInstance, esIndex, t.props);
    sTypeSchema += `
    type ${t.type} {
      ${gqlTypes.map(entry => `${entry.field}: ${entry.type},`).join('\n')}
    }
  `;
  }
  // log.info(sTypeSchema);
  return sTypeSchema;
};

const getAggregationType = (entry) => {
  if (entry.aggType !== '') {
    return `${entry.field}: ${entry.aggType},`;
  }
  return '';
};

const getAggregationSchemaForOneIndex = (esInstance, esIndex, esType) => {
  const esTypeObjName = firstLetterUpperCase(esType);
  const fieldGQLTypeMap = getFieldGQLTypeMapForOneIndex(esInstance, esIndex);
  // console.info(fieldGQLTypeMap);
  const fieldAggsTypeMap = fieldGQLTypeMap.filter(f => f.type !== 'Object').map(entry => ({
    field: entry.field,
    aggType: getAggsHistogramName(entry.type),
  }));
  const aggsSchema = `type ${esTypeObjName}Aggregation {
    _totalCount: Int
    ${fieldAggsTypeMap.map(entry => `${getAggregationType(entry)}`).join('\n')}
  }`;
  return aggsSchema;
};

export const getQuerySchema = (esConfig, esInstance) => `
    type Query {
      ${esConfig.indices.map(cfg => getQuerySchemaForType(esInstance, cfg.index, cfg.type)).join('\n')}
      _aggregation: Aggregation
      _mapping: Mapping
    }
  `;

export const getTypesSchemas = (esConfig, esInstance) => esConfig.indices.map(cfg => getTypeSchemaForOneIndex(esInstance, cfg.index, cfg.type)).join('\n');

export const getAggregationSchema = esConfig => `
    type Aggregation {
      ${esConfig.indices.map(cfg => `${cfg.type} (
        filter: JSON, 
        filterSelf: Boolean=true, 
        nestedAggFields: JSON,
        """Only used when it's regular level data commons, if set, returns aggregation data within given accessibility"""
        accessibility: Accessibility=all
      ): ${firstLetterUpperCase(cfg.type)}Aggregation`).join('\n')}
    }
  `;

export const getAggregationSchemaForEachType = (esConfig, esInstance) => esConfig.indices.map(cfg => getAggregationSchemaForOneIndex(esInstance, cfg.index, cfg.type)).join('\n');

export const getMappingSchema = esConfig => `
    type Mapping {
      ${esConfig.indices.map(cfg => `${cfg.type}: [String]`).join('\n')}
    }
  `;

export const buildSchemaString = (esConfig, esInstance) => {
  const querySchema = getQuerySchema(esConfig, esInstance);

  const matchedItemSchema = `
    type MatchedItem {
      field: String
      highlights: [String]
    }
  `;

  const typesSchemas = getTypesSchemas(esConfig, esInstance);

  const accessibilityEnum = `
    enum Accessibility {
      all
      accessible
      unaccessible
    }
  `;

  const aggregationSchema = getAggregationSchema(esConfig);

  const aggregationSchemasForEachType = getAggregationSchemaForEachType(esConfig, esInstance);

  const textHistogramSchema = `
    type ${EnumAggsHistogramName.HISTOGRAM_FOR_STRING} {
      histogram: [BucketsForNestedStringAgg]
    }
  `;

  const textHistogramBucketSchema = `
    type BucketsForNestedStringAgg {
      key: String
      count: Int
      missingFields: [BucketsForNestedMissingFields]
      termsFields: [BucketsForNestedTermsFields]
    }
  `;

  const nestedMissingFieldsBucketSchema = `
    type BucketsForNestedMissingFields {
      field: String
      count: Int
    }
  `;

  const nestedTermsFieldsBucketSchema = `
    type BucketsForNestedTermsFields {
      field: String
      terms: [BucketsForString]
    }
  `;

  const stringBucketSchema = `
    type BucketsForString {
      key: String
      count: Int
    }
  `;

  const numberHistogramSchema = `
    type ${EnumAggsHistogramName.HISTOGRAM_FOR_NUMBER} {
      histogram(
        rangeStart: Int, 
        rangeEnd: Int, 
        rangeStep: Int,
        binCount: Int,
      ): [BucketsForNestedNumberAgg],
      asTextHistogram: [BucketsForNestedStringAgg]
    }
  `;

  const numberHistogramBucketSchema = `
    type BucketsForNestedNumberAgg {
      """Lower and higher bounds for this bucket"""
      key: [Float]
      min: Float
      max: Float
      avg: Float
      sum: Float
      count: Int
      missingFields: [BucketsForNestedMissingFields]
      termsFields: [BucketsForNestedTermsFields]
    }
  `;

  const mappingSchema = getMappingSchema(esConfig);

  const schemaStr = `
  scalar JSON
  ${matchedItemSchema}
  ${querySchema}
  ${accessibilityEnum}
  ${typesSchemas}
  ${aggregationSchema}
  ${aggregationSchemasForEachType}
  ${textHistogramSchema}
  ${numberHistogramSchema}
  ${textHistogramBucketSchema}
  ${nestedMissingFieldsBucketSchema}
  ${nestedTermsFieldsBucketSchema}
  ${stringBucketSchema}
  ${numberHistogramBucketSchema}
  ${mappingSchema}
`;
  log.info('[schema] graphql schema generated.');
  log.info('[schema] graphql schema', schemaStr);
  return schemaStr;
};

const getSchema = (esConfig, esInstance) => {
  const schemaStr = buildSchemaString(esConfig, esInstance);
  const finalSchema = gql`${schemaStr}`;
  return finalSchema;
};

export default getSchema;
