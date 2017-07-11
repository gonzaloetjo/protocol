const AragonToken = artifacts.require('./AragonToken.sol');
const AventusToken = artifacts.require('./AventusToken.sol');
const BasicAttentionToken = artifacts.require('./BasicAttentionToken.sol');
const BancorToken = artifacts.require('./BancorToken.sol');
const BitcoinToken = artifacts.require('./BitcoinToken.sol');
const DigixDaoToken = artifacts.require('./DigixDaoToken.sol');
const DigixGoldToken = artifacts.require('./DigixGoldToken.sol');
const DogecoinToken = artifacts.require('./DogecoinToken.sol');
const EtherClassicToken = artifacts.require('./EtherClassicToken.sol');
const EtherToken = artifacts.require('./EtherToken.sol');
const EuroToken = artifacts.require('./EuroToken.sol');
const GnosisToken = artifacts.require('./GnosisToken.sol');
const GolemToken = artifacts.require('./GolemToken.sol');
const IconomiToken = artifacts.require('./IconomiToken.sol');
const LitecoinToken = artifacts.require('./LitecoinToken.sol');
const MelonToken = artifacts.require('./MelonToken.sol');
const RepToken = artifacts.require('./RepToken.sol');
const RippleToken = artifacts.require('./RippleToken.sol');
const StatusToken = artifacts.require('./StatusToken.sol');
const PriceFeed = artifacts.require('./PriceFeed.sol');
const Exchange = artifacts.require('./Exchange.sol');
const Universe = artifacts.require('./Universe.sol');

const assetList = [
  EtherToken,   // [0] refAsset token
  MelonToken,   // [1] MLN token
  AragonToken,  // rest alphabetical
  AventusToken,
  BasicAttentionToken,
  BancorToken,
  BitcoinToken,
  DigixDaoToken,
  DigixGoldToken,
  DogecoinToken,
  EtherClassicToken,
  EuroToken,
  GnosisToken,
  GolemToken,
  IconomiToken,
  LitecoinToken,
  RepToken,
  RippleToken,
  StatusToken,
];

module.exports = (deployer, network, accounts) => {
  let feedBackupOwner;
  if (network === 'development') feedBackupOwner = accounts[0];
  else if (network === 'kovan') feedBackupOwner = accounts[0];
  return deployer.deploy(assetList)
  .then(() => deployer.deploy(Exchange))
  .then(() => deployer.deploy(PriceFeed, feedBackupOwner, EtherToken.address))
  .then(() =>
    deployer.deploy(
      Universe,
      assetList.map(a => a.address),
      Array(assetList.length).fill(PriceFeed.address),
      Array(assetList.length).fill(Exchange.address),
    )
  );
};
