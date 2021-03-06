import { BN, toWei } from 'web3-utils';

import { partialRedeploy } from '~/deploy/scripts/deploy-system';
import { call, send } from '~/deploy/utils/deploy-contract';
import getAccounts from '~/deploy/utils/getAccounts';
import web3 from '~/deploy/utils/get-web3';

import { BNExpDiv } from '~/tests/utils/BNmath';
import { CONTRACT_NAMES, EMPTY_ADDRESS } from '~/tests/utils/constants';
import { setupFundWithParams } from '~/tests/utils/fund';
import { delay } from '~/tests/utils/time';
import updateTestingPriceFeed from '~/tests/utils/updateTestingPriceFeed';

let deployer, investor, thirdPartyCaller;
let defaultTxOpts, investorTxOpts, gasPrice;
let mln, weth;
let priceSource, registry, sharesRequestor;
let basicRequest, basicTokenPriceData;

beforeAll(async () => {
  [deployer, investor, thirdPartyCaller] = await getAccounts();
  gasPrice = toWei('2', 'gwei');
  defaultTxOpts = { from: deployer, gas: 8000000, gasPrice };
  investorTxOpts = { ...defaultTxOpts, from: investor };

  const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY]);
  const contracts = deployed.contracts;

  priceSource = contracts[CONTRACT_NAMES.TESTING_PRICEFEED];
  registry = contracts[CONTRACT_NAMES.REGISTRY];
  sharesRequestor = contracts[CONTRACT_NAMES.SHARES_REQUESTOR];
  weth = contracts.WETH;
  mln = contracts.MLN;

  basicRequest = {
    owner: investor,
    investmentAssetContract: weth,
    investmentAmount: toWei('1', 'ether'),
    minSharesQuantity: "0",
    txOpts: investorTxOpts,
    amguValue: toWei('0.1', 'ether')
  };

  basicTokenPriceData = {
    priceSource,
    tokenAddresses: [weth.options.address, mln.options.address],
    tokenPrices: [toWei('1', 'ether'), toWei('2', 'ether')]
  };
});

describe('cancelRequest', () => {
  let fundFactory;
  let fund;
  let incentiveFee;
  let requestTxBlock, cancelTxBlock;

  beforeAll(async () => {
    const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
    const contracts = deployed.contracts;
    fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

    // @dev include initial investment so test doesn't bypass Request creation
    fund = await setupFundWithParams({
      initialInvestment: {
        contribAmount: toWei('1', 'ether'),
        investor: deployer,
        tokenContract: weth
      },
      quoteToken: weth.options.address,
      fundFactory
    });

    await createRequest(fund.hub.options.address, basicRequest);
    requestTxBlock = await web3.eth.getBlockNumber();

    incentiveFee = await call(registry, 'incentive');
  });

  it('does NOT allow cancellation when a cancellation condition is not met', async () => {
    await expect(
      send(sharesRequestor, 'cancelRequest', [fund.hub.options.address], basicRequest.txOpts)
    ).rejects.toThrowFlexible("No cancellation condition was met");
  });

  it('succeeds when cancellation condition is met', async () => {
    // Shut down the fund so cancellation condition passes
    await send(fund.hub, 'shutDownFund', [], defaultTxOpts);

    await expect(
      send(sharesRequestor, 'cancelRequest', [fund.hub.options.address], basicRequest.txOpts)
    ).resolves.not.toThrow();

    cancelTxBlock = await web3.eth.getBlockNumber();
  });

  it('removes request from state', async () => {
    const request = await call(
      sharesRequestor,
      'ownerToRequestByFund',
      [basicRequest.owner, fund.hub.options.address]
    );
    expect(request.timestamp).toBe("0");
  });

  it('emits correct RequestCanceled event', async() => {
    const events = await sharesRequestor.getPastEvents(
      'RequestCanceled',
      {
        fromBlock: cancelTxBlock,
        toBlock: 'latest'
      }
    );
    expect(events.length).toBe(1);

    const eventValues = events[0].returnValues;
    expect(eventValues.requestOwner).toBe(basicRequest.owner);
    expect(eventValues.hub).toBe(fund.hub.options.address);
    expect(eventValues.investmentAmount).toBe(basicRequest.investmentAmount);
    expect(eventValues.minSharesQuantity).toBe(basicRequest.minSharesQuantity);
    expect(Number(eventValues.createdTimestamp)).toBe(
      Number((await web3.eth.getBlock(requestTxBlock)).timestamp)
    );
    expect(eventValues.incentiveFee).toBe(incentiveFee);
  });
});

describe('executeRequestFor', () => {
  describe('Bad Requests', () => {
    let fund;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];
  
      fund = await setupFundWithParams({
        quoteToken: weth.options.address,
        fundFactory,
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        }
      });
    });

    it('does NOT allow non-existing Request', async () => {
      await expect(
        send(
          sharesRequestor,
          'executeRequestFor',
          [basicRequest.owner, fund.hub.options.address],
          basicRequest.txOpts
        )
      ).rejects.toThrowFlexible("Request does not exist");
    });

    it('does NOT allow request execution without a price update', async () => {
      await createRequest(fund.hub.options.address, basicRequest);

      await expect (
        send(
          sharesRequestor,
          'executeRequestFor',
          [basicRequest.owner, fund.hub.options.address],
          basicRequest.txOpts
        )
      ).rejects.toThrowFlexible("Price has not updated since request");      
    });
  });

  describe('executeRequestFor (third party)', () => {
    let fund;
    let request, txReceipt;
    let expectedShares;
    let preTxBlock, preCallerEth, postCallerEth, preOwnerShares, postOwnerShares;
    let preOwnerInvestmentAssetBalance, postOwnerInvestmentAssetBalance;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      // @dev include initial investment so test doesn't bypass Request creation
      fund = await setupFundWithParams({
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        },
        quoteToken: weth.options.address,
        fundFactory
      });

      // Create request and update price
      await createRequest(fund.hub.options.address, basicRequest);
      request = await call(
        sharesRequestor,
        'ownerToRequestByFund',
        [basicRequest.owner, fund.hub.options.address]
      );

      const sharePrice = new BN(await call(fund.shares, 'calcSharePrice'));
      expectedShares = BNExpDiv(new BN(request.investmentAmount), sharePrice);
    });

    it('succeeds', async() => {
      preTxBlock = await web3.eth.getBlockNumber();
      preCallerEth = new BN(await web3.eth.getBalance(thirdPartyCaller));
      preOwnerInvestmentAssetBalance = new BN(
        await call(basicRequest.investmentAssetContract, 'balanceOf', [basicRequest.owner])
      );
      preOwnerShares = new BN(await call(fund.shares, 'balanceOf', [basicRequest.owner]));

      const thirdPartyCallerTxOpts = { ...basicRequest.txOpts, from: thirdPartyCaller };

      txReceipt = await executeRequest(
        fund.hub.options.address,
        {...basicRequest, txOpts: thirdPartyCallerTxOpts},
        basicTokenPriceData
      );

      postCallerEth = new BN(await web3.eth.getBalance(thirdPartyCaller));
      postOwnerInvestmentAssetBalance = new BN(
        await call(basicRequest.investmentAssetContract, 'balanceOf', [basicRequest.owner])
      );
      postOwnerShares = new BN(await call(fund.shares, 'balanceOf', [basicRequest.owner]));
    });

    it('issues correct shares to request owner', async() => {
      expect(postOwnerShares.sub(preOwnerShares)).bigNumberEq(expectedShares);
    });

    it('removes Request', async() => {
      const request = await call(
        sharesRequestor,
        'ownerToRequestByFund',
        [basicRequest.owner, fund.hub.options.address]
      );
      expect(request.timestamp).toBe("0");
    });

    // @dev This works right now because amgu is set to 0
    it('sends incentive fee to caller', async() => {
      const gasSpent = new BN(txReceipt.gasUsed).mul(new BN(gasPrice));
      expect(new BN(request.incentiveFee).sub(gasSpent)).bigNumberEq(
        postCallerEth.sub(preCallerEth)
      );
    });

    it('emits correct RequestExecuted event', async() => {
      const events = await sharesRequestor.getPastEvents(
        'RequestExecuted',
        {
          fromBlock: Number(preTxBlock)+1,
          toBlock: 'latest'
        }
      );
      expect(events.length).toBe(1);

      const eventValues = events[0].returnValues;
      expect(eventValues.caller).toBe(thirdPartyCaller);
      expect(eventValues.requestOwner).toBe(basicRequest.owner);
      expect(eventValues.investmentAmount).toBe(request.investmentAmount);
      expect(eventValues.minSharesQuantity).toBe(request.minSharesQuantity);
      expect(eventValues.createdTimestamp).toBe(request.timestamp);
      expect(eventValues.incentiveFee).toBe(request.incentiveFee);
      expect(eventValues.sharesBought).toBe(expectedShares.toString());
    });
  });

  describe('executeRequestFor (self)', () => {
    let fund;
    let request, txReceipt;
    let expectedShares;
    let preTxBlock, preOwnerEth, postOwnerEth, preOwnerShares, postOwnerShares;
    let preOwnerInvestmentAssetBalance, postOwnerInvestmentAssetBalance;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      // @dev include initial investment so test doesn't bypass Request creation
      fund = await setupFundWithParams({
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        },
        quoteToken: weth.options.address,
        fundFactory
      });

      // Create request and update price
      await createRequest(fund.hub.options.address, basicRequest);
      request = await call(
        sharesRequestor,
        'ownerToRequestByFund',
        [basicRequest.owner, fund.hub.options.address]
      );

      const sharePrice = new BN(await call(fund.shares, 'calcSharePrice'));
      expectedShares = BNExpDiv(new BN(request.investmentAmount), sharePrice);
    });

    it('succeeds', async() => {
      preTxBlock = await web3.eth.getBlockNumber();
      preOwnerEth = new BN(await web3.eth.getBalance(basicRequest.owner));
      preOwnerInvestmentAssetBalance = new BN(
        await call(basicRequest.investmentAssetContract, 'balanceOf', [basicRequest.owner])
      );
      preOwnerShares = new BN(await call(fund.shares, 'balanceOf', [basicRequest.owner]));

      txReceipt = await executeRequest(
        fund.hub.options.address,
        basicRequest,
        basicTokenPriceData
      );

      postOwnerEth = new BN(await web3.eth.getBalance(basicRequest.owner));
      postOwnerInvestmentAssetBalance = new BN(
        await call(basicRequest.investmentAssetContract, 'balanceOf', [basicRequest.owner])
      );
      postOwnerShares = new BN(await call(fund.shares, 'balanceOf', [basicRequest.owner]));
    });

    it('issues correct shares to request owner', async() => {
      expect(postOwnerShares.sub(preOwnerShares)).bigNumberEq(expectedShares);
    });

    it('removes Request', async() => {
      const request = await call(
        sharesRequestor,
        'ownerToRequestByFund',
        [basicRequest.owner, fund.hub.options.address]
      );
      expect(request.timestamp).toBe("0");
    });

    // @dev This works right now because amgu is set to 0
    it('sends incentive fee to request owner', async() => {
      const gasSpent = new BN(txReceipt.gasUsed).mul(new BN(gasPrice));
      expect(new BN(request.incentiveFee).sub(gasSpent)).bigNumberEq(
        postOwnerEth.sub(preOwnerEth)
      );
    });

    it('emits correct RequestExecuted event', async() => {
      const events = await sharesRequestor.getPastEvents(
        'RequestExecuted',
        {
          fromBlock: Number(preTxBlock)+1,
          toBlock: 'latest'
        }
      );
      expect(events.length).toBe(1);

      const eventValues = events[0].returnValues;
      expect(eventValues.caller).toBe(basicRequest.owner);
      expect(eventValues.requestOwner).toBe(basicRequest.owner);
      expect(eventValues.investmentAmount).toBe(request.investmentAmount);
      expect(eventValues.minSharesQuantity).toBe(request.minSharesQuantity);
      expect(eventValues.createdTimestamp).toBe(request.timestamp);
      expect(eventValues.incentiveFee).toBe(request.incentiveFee);
      expect(eventValues.sharesBought).toBe(expectedShares.toString());
    });
  });
});

describe('requestShares', () => {
  describe('Bad Requests', () => {
    let fundFactory;
    let fund;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      fund = await setupFundWithParams({
        quoteToken: weth.options.address,
        fundFactory
      });
    });

    it('does NOT allow empty param values', async() => {
      const badRequestInvestmentAmount = { ...basicRequest, investmentAmount: "0" };

      // Empty hub
      await expect(
        send(
          sharesRequestor,
          'requestShares',
          [
            EMPTY_ADDRESS,
            basicRequest.investmentAmount,
            basicRequest.minSharesQuantity
          ],
          { ...basicRequest.txOpts, value: basicRequest.amguValue }
        )
      ).rejects.toThrowFlexible("_hub cannot be empty");

      await expect(
        createRequest(fund.hub.options.address, badRequestInvestmentAmount)
      ).rejects.toThrowFlexible("_investmentAmount must be > 0");
    });

    it('does NOT allow request with insufficient token allowance', async() => {
      const badApprovalAmount = new BN(basicRequest.investmentAmount).sub(new BN(1)).toString();
      await send(
        basicRequest.investmentAssetContract,
        'approve',
        [sharesRequestor.options.address, badApprovalAmount],
        basicRequest.txOpts
      );
      await expect(
        send(
          sharesRequestor,
          'requestShares',
          [
            fund.hub.options.address,
            basicRequest.investmentAmount,
            basicRequest.minSharesQuantity
          ],
          { ...basicRequest.txOpts, value: basicRequest.amguValue }
        )
      ).rejects.toThrow();
    });

    it('does NOT allow request for a shutdown fund', async() => {
      await send(fund.hub, 'shutDownFund', [], defaultTxOpts);
      await expect(
        createRequest(fund.hub.options.address, basicRequest)
      ).rejects.toThrowFlexible("Fund is not active");
    });
  });

  describe('Good Request: nth investment', () => {
    let fund;
    let incentiveFee;
    let preTxBlock, preSharesRequestorEth, postSharesRequestorEth;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      // @dev include initial investment so test doesn't bypass Request creation
      fund = await setupFundWithParams({
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        },
        quoteToken: weth.options.address,
        fundFactory
      });

      incentiveFee = await call(registry, 'incentive');
    });

    it('succeeds', async() => {
      await send(
        basicRequest.investmentAssetContract,
        'approve',
        [sharesRequestor.options.address, basicRequest.investmentAmount],
        basicRequest.txOpts
      );

      preTxBlock = await web3.eth.getBlockNumber();

      preSharesRequestorEth = new BN(await web3.eth.getBalance(sharesRequestor.options.address));

      await expect(
        send(
          sharesRequestor,
          'requestShares',
          [
            fund.hub.options.address,
            basicRequest.investmentAmount,
            basicRequest.minSharesQuantity
          ],
          { ...basicRequest.txOpts, value: basicRequest.amguValue }
        )
      ).resolves.not.toThrow();

      postSharesRequestorEth = new BN(await web3.eth.getBalance(sharesRequestor.options.address));
    });

    it('adds correct Request', async() => {
      const request = await call(
        sharesRequestor,
        'ownerToRequestByFund',
        [basicRequest.owner, fund.hub.options.address]
      );
      expect(request.investmentAmount).toBe(basicRequest.investmentAmount);
      expect(request.minSharesQuantity).toBe(basicRequest.minSharesQuantity);
      expect(Number(request.timestamp)).toBe((await web3.eth.getBlock('latest')).timestamp);
      expect(request.incentiveFee).toBe(incentiveFee);
    });

    it('custodies incentive fee', async() => {
      const sharesRequestEthBalanceDiff = postSharesRequestorEth.sub(preSharesRequestorEth);
      expect(sharesRequestEthBalanceDiff).bigNumberEq(new BN(incentiveFee));
    });

    it('emits correct RequestCreated event', async() => {
      const events = await sharesRequestor.getPastEvents(
        'RequestCreated',
        {
          fromBlock: Number(preTxBlock)+1,
          toBlock: 'latest'
        }
      );
      expect(events.length).toBe(1);

      const eventValues = events[0].returnValues;
      expect(eventValues.requestOwner).toBe(basicRequest.owner);
      expect(eventValues.hub).toBe(fund.hub.options.address);
      expect(eventValues.investmentAmount).toBe(basicRequest.investmentAmount);
      expect(eventValues.minSharesQuantity).toBe(basicRequest.minSharesQuantity);
      expect(eventValues.incentiveFee).toBe(incentiveFee);
    });
  });

  describe('Multiple requests', () => {
    let fund;

    beforeAll(async () => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      // @dev include initial investment so test doesn't bypass Request creation
      fund = await setupFundWithParams({
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        },
        quoteToken: weth.options.address,
        fundFactory
      });

      await createRequest(fund.hub.options.address, basicRequest);
    });

    it('does NOT allow more than one request per fund', async() => {
      await expect(
        createRequest(fund.hub.options.address, basicRequest)
      ).rejects.toThrowFlexible("Only one request can exist (per fund)");
    });

    it('allows requests for multiple funds', async() => {
      const deployed = await partialRedeploy([CONTRACT_NAMES.FUND_FACTORY], true);
      const contracts = deployed.contracts;
      const fundFactory = contracts[CONTRACT_NAMES.FUND_FACTORY];

      const fund2 = await setupFundWithParams({
        initialInvestment: {
          contribAmount: toWei('1', 'ether'),
          investor: deployer,
          tokenContract: weth
        },
        quoteToken: weth.options.address,
        fundFactory
      });

      await expect(
        createRequest(fund2.hub.options.address, basicRequest)
      ).resolves.not.toThrow();
    });
  });
});

const createRequest = async (fundAddress, request) => {
  // Fund investor with contribution token, if necessary
  const investorTokenBalance = new BN(
    await call(
      request.investmentAssetContract,
      'balanceOf',
      [request.owner]
    )
  );
  const investorTokenShortfall =
    new BN(request.investmentAmount).sub(investorTokenBalance);
  if (investorTokenShortfall.gt(new BN(0))) {
    await send(
      request.investmentAssetContract,
      'transfer',
      [request.owner, investorTokenShortfall.toString()]
    )
  }

  // Approve and send request
  await send(
    request.investmentAssetContract,
    'approve',
    [sharesRequestor.options.address, request.investmentAmount],
    request.txOpts
  );
  return send(
    sharesRequestor,
    'requestShares',
    [
      fundAddress,
      request.investmentAmount,
      request.minSharesQuantity
    ],
    { ...request.txOpts, value: request.amguValue }
  );
};

const executeRequest = async (fundAddress, request, tokenPriceData) => {
  await delay(1000);
  await updateTestingPriceFeed(
    tokenPriceData.priceSource,
    tokenPriceData.tokenAddresses,
    tokenPriceData.tokenPrices
  );
  return send(
    sharesRequestor,
    'executeRequestFor',
    [request.owner, fundAddress],
    request.txOpts
  );
};
