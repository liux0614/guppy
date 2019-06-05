import { ApolloError, UserInputError } from 'apollo-server';
import { esFieldNumericTextTypeMapping, NumericTextTypeTypeEnum, SCROLL_PAGE_SIZE } from './const';

const getNumericTextType = (
  esInstance,
  esIndex,
  field,
) => {
  if (!esInstance.fieldTypes[esIndex] || !esInstance.fieldTypes[esIndex][field]) {
    throw new UserInputError('Please check your syntax for input "filter" argument');
  }
  const numericTextType = esFieldNumericTextTypeMapping[esInstance.fieldTypes[esIndex][field]];
  if (typeof numericTextType === 'undefined') {
    throw new ApolloError(`ES type ${esInstance.fieldTypes[esIndex][field]} not supported.`, 500);
  }
  return numericTextType;
};

// FIXME: support "is not"
const getFilterItemForString = (op, field, value) => {
  switch (op) {
    case '=':
    case 'eq':
    case 'EQ':
      return {
        term: {
          [field]: value,
        },
      };
    case 'in':
    case 'IN':
      return {
        terms: {
          [field]: value,
        },
      };
    default:
      throw new UserInputError(`Invalid operation "${op}" in filter argument.`);
  }
};

const getFilterItemForNumbers = (op, field, value) => {
  const rangeOperator = {
    '>': 'gt',
    gt: 'gt',
    GT: 'gt',
    '>=': 'gte',
    gte: 'gte',
    GTE: 'gte',
    '<': 'lt',
    lt: 'lt',
    LT: 'lt',
    '<=': 'lte',
    lte: 'lte',
    LTE: 'lte',
  };
  if (op in rangeOperator) {
    return {
      range: {
        [field]: { [rangeOperator[op]]: value },
      },
    };
  }
  if (op === '=' || op === 'eq' || op === 'EQ') {
    return {
      term: {
        [field]: value,
      },
    };
  }
  if (op === 'IN' || op === 'in') {
    return {
      terms: {
        [field]: value,
      },
    };
  }
  throw new UserInputError(`Invalid numeric operation "${op}" for field "${field}" in filter argument`);
};

/**
 * This function transfer graphql filter arg to ES filter object
 * It first parse graphql filter object recursively from top to down,
 * until reach the bottom level, it translate gql filter unit to ES filter unit.
 * And finally combines all filter units from down to top.
 * @param {string} esInstance
 * @param {string} esIndex
 * @param {string} esType
 * @param {object} graphqlFilterObj
 * @param {string[]} aggsField - target agg field, only need for agg queries
 * @param {boolean} filterSelf - whether we want to filter this field or not,
 *                               only need for agg queries
 */
export const getFilterObj = (
  esInstance,
  esIndex,
  esType,
  graphqlFilterObj,
  aggsField,
  filterSelf = true,
  defaultAuthFilter = {},
) => {
  if (!graphqlFilterObj) return null;
  const topLevelOp = Object.keys(graphqlFilterObj)[0];
  if (typeof topLevelOp === 'undefined') return null;
  let resultFilterObj = {};
  const topLevelOpLowerCase = topLevelOp.toLowerCase();
  if (topLevelOpLowerCase === 'and' || topLevelOpLowerCase === 'or') {
    const boolConnectOp = topLevelOpLowerCase === 'and' ? 'must' : 'should';
    const boolItemsList = [];
    graphqlFilterObj[topLevelOp].forEach((filterItem) => {
      const filterObj = getFilterObj(
        esInstance, esIndex, esType, filterItem, aggsField, filterSelf, defaultAuthFilter,
      );
      if (filterObj) {
        boolItemsList.push(filterObj);
      }
    });
    if (boolItemsList.length === 0) {
      resultFilterObj = null;
    } else {
      resultFilterObj = {
        bool: {
          [boolConnectOp]: boolItemsList,
        },
      };
    }
  } else {
    const field = Object.keys(graphqlFilterObj[topLevelOp])[0];
    if (aggsField === field && !filterSelf) {
      // if `filterSelf` flag is false, should not filter the target field itself,
      // instead, only apply an auth filter if exists
      return getFilterObj(esInstance, esIndex, esType, defaultAuthFilter);
    }
    const value = graphqlFilterObj[topLevelOp][field];
    const numericOrTextType = getNumericTextType(esInstance, esIndex, field);
    if (numericOrTextType === NumericTextTypeTypeEnum.ES_TEXT_TYPE) {
      resultFilterObj = getFilterItemForString(topLevelOp, field, value);
    } else if (numericOrTextType === NumericTextTypeTypeEnum.ES_NUMERIC_TYPE) {
      resultFilterObj = getFilterItemForNumbers(topLevelOp, field, value);
    } else {
      throw new ApolloError(`Invalid es field type ${numericOrTextType}`, 500);
    }
  }
  return resultFilterObj;
};

/**
 * Transfer graphql sort arg to ES sort object
 * @param {object} graphqlSort
 */
export const getESSortBody = (graphqlSort, esInstance, esIndex) => {
  let sortBody;
  if (typeof graphqlSort !== 'undefined') {
    let graphqlSortObj = graphqlSort;
    if (typeof (graphqlSort.length) === 'undefined') {
      graphqlSortObj = Object.keys(graphqlSort).map(field => ({ [field]: graphqlSort[field] }));
    }
    // check fields and sort methods are valid
    for (let i = 0; i < graphqlSortObj.length; i += 1) {
      if (!graphqlSortObj[i] || Object.keys(graphqlSortObj[i]).length !== 1) {
        throw new UserInputError('Invalid sort argument');
      }
      const field = Object.keys(graphqlSortObj[i])[0];
      if (typeof esInstance.fieldTypes[esIndex][field] === 'undefined') {
        throw new UserInputError('Invalid sort argument');
      }
      const method = graphqlSortObj[i][field];
      if (method !== 'asc' && method !== 'desc') {
        throw new UserInputError('Invalid sort argument');
      }
    }
    sortBody = graphqlSortObj;
  }
  return sortBody;
};

const filterData = (
  { esInstance, esIndex, esType },
  {
    filter, fields = [], sort, offset = 0, size,
  },
) => {
  const queryBody = { from: offset };
  if (typeof filter !== 'undefined') {
    queryBody.query = getFilterObj(esInstance, esIndex, esType, filter);
  }
  queryBody.sort = getESSortBody(sort, esInstance, esIndex);
  if (typeof size !== 'undefined') {
    queryBody.size = size;
  }
  if (fields && fields.length > 0) {
    queryBody._source = fields;
  }
  const resultPromise = esInstance.query(esIndex, esType, queryBody);
  return resultPromise;
};

export const getDataUsingScroll = (
  { esInstance, esIndex, esType },
  { filter, fields, sort },
) => {
  const esFilterObj = filter ? getFilterObj(esInstance, esIndex, esType, filter) : undefined;
  return esInstance.scrollQuery(esIndex, esType, {
    filter: esFilterObj,
    fields,
    sort: getESSortBody(sort, esInstance, esIndex),
  });
};

export const getCount = async (esInstance, esIndex, esType, filter) => {
  const result = await filterData({ esInstance, esIndex, esType }, { filter, fields: [] });
  return result.hits.total;
};

export const getData = async (
  {
    esInstance,
    esIndex,
    esType,
  }, {
    fields,
    filter,
    sort,
    offset = 0,
    size,
  }) => {
  if (typeof size !== 'undefined' && offset + size > SCROLL_PAGE_SIZE) {
    throw new UserInputError(`Large graphql query forbidden for offset + size > ${SCROLL_PAGE_SIZE}, 
    offset = ${offset} and size = ${size},
    please use download endpoint for large data queries instead.`);
  }
  const result = await filterData(
    { esInstance, esIndex, esType },
    {
      filter, fields, sort, offset, size,
    },
  );
  return result.hits.hits.map(item => item._source);
};
